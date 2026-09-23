import { supabaseAdmin } from "@/lib/database/supabase-server";
import { encryptToken } from "@/lib/utils/token-encryption";
import { WorkflowService } from "@/lib/services/workflow-service";
import { ensureProjectWebhook, ensureSenderWebhook, mapInvitationStatus } from "./client";
import { getCachedJson, setCachedJson, sha256 } from "@/lib/security/upstash-rest";
import { refreshSiteConfigurationCaches } from "@/lib/services/site-configuration-cache";
export {
  handleVoiceCallEvent,
  resolveVoiceCallWebhookStatus,
} from "./voice-webhook-handler";

async function findSettingsForDomain(domainId: string) {
  const { data, error } = await supabaseAdmin
    .from("settings")
    .select("id, site_id, channels")
    .contains("channels", {
      connections: [{ metadata: { email_domain_id: domainId } }],
    });

  if (error) {
    console.error("[Zavu Webhook] DB error finding domain:", error);
    throw error;
  }
  return data || [];
}

async function findSettingsForInvitation(invitationId: string) {
  const { data, error } = await supabaseAdmin
    .from("settings")
    .select("id, site_id, channels")
    .contains("channels", {
      connections: [{ zavu_invitation_id: invitationId }],
    });

  if (error) {
    console.error("[Zavu Webhook] DB error finding invitation:", error);
    throw error;
  }
  return data || [];
}

export async function findSettingsForSender(
  senderId: string,
  options?: { skipCache?: boolean }
) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(senderId)) return [];
  const cacheKey = `zavu:sender-settings:${await sha256(senderId)}`;
  if (!options?.skipCache) {
    const cached = await getCachedJson<any[]>(cacheKey);
    if (cached) return cached;
  }
  const { data, error } = await supabaseAdmin
    .from("settings")
    .select("id, site_id, channels")
    .contains("channels", {
      connections: [{ zavu_sender_id: senderId }],
    });

  if (error) {
    console.error("[Zavu Webhook] DB error finding sender:", error);
    throw error;
  }
  const settings = data || [];
  await setCachedJson(cacheKey, settings, settings.length ? 300 : 30);
  return settings;
}

async function getUserIdFromSite(siteId: string): Promise<string | undefined> {
  const { data, error } = await supabaseAdmin
    .from("sites")
    .select("user_id")
    .eq("id", siteId)
    .maybeSingle();
  if (error) {
    throw error;
  }
  return data?.user_id || undefined;
}

export async function handleInboundMessage(event: any) {
  const data = event.data;
  if (!data || !data.from) {
    console.warn("[Zavu Webhook] Inbound event missing data.from");
    return;
  }

  // Handle cases where media comes without text
  let messageText = data.text || data.body || data.caption;
  
  if (!messageText) {
    if (data.messageType === "image" || data.messageType === "video" || data.messageType === "audio" || data.messageType === "document" || data.messageType === "sticker" || data.messageType === "location" || data.messageType === "contact") {
      messageText = `[${data.messageType}]`;
    } else {
      console.warn("[Zavu Webhook] Inbound event missing message text or valid media type");
      return;
    }
  }

  const senderId = event.senderId || data.senderId || event.sender?.id;
  if (!senderId) {
    console.warn("[Zavu Webhook] No senderId found for inbound message");
    return;
  }

  const sites = await findSettingsForSender(senderId);
  if (sites.length === 0) {
    console.warn(`[Zavu Webhook] No site found for sender ${senderId}`);
    return;
  }

  const siteId = sites[0].site_id;
  const channel = data.channel;
  if (!channel || channel === "zavu") {
    console.warn("[Zavu Webhook] Inbound event missing a valid channel");
    return;
  }

  const rawFrom = String(data.from);
  const identity = rawFrom.includes(":") ? rawFrom.split(":").slice(1).join(":") : rawFrom;
  const isEmail = channel === "email" || identity.includes("@");
  const userId = await getUserIdFromSite(siteId);

  console.log(`[Zavu Webhook] Starting customerSupport workflow for ${channel} on site ${siteId}`);

  const workflowService = WorkflowService.getInstance();
  const workflowResult = await workflowService.customerSupportMessage(
    {
      userId,
      message: messageText,
      site_id: siteId,
      name: data.profileName,
      email: isEmail ? identity : undefined,
      phone: isEmail ? undefined : identity,
      origin: channel,
      origin_message_id: data.messageId || event.id,
      channel_delivery: true,
      website_chat_origin: false,
    },
    {
      priority: "high",
      async: false,
      retryAttempts: 3,
      taskQueue: "high",
      workflowId: `customer-support-${channel}-${siteId}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    }
  );

  if (workflowResult.success) {
    console.log(`[Zavu Webhook] customerSupport workflow started: ${workflowResult.workflowId}`);
  } else {
    console.error("[Zavu Webhook] customerSupport workflow failed:", workflowResult.error);
    throw new Error(
      `Zavu customer support workflow failed: ${String(workflowResult.error)}`,
    );
  }
}

export async function handleDomainStatusChanged(data: any, eventType: string) {
  const domainId = data.domainId || data.id;
  const status = eventType === "domain.verified" ? "verified" : "failed";

  if (!domainId) {
    console.warn("[Zavu Webhook] domain event missing domainId");
    return;
  }

  console.log(`[Zavu Webhook] Domain ${domainId} status changed to ${status}`);

  const sites = await findSettingsForDomain(domainId);
  if (sites.length === 0) {
    console.warn(`[Zavu Webhook] No site found for domain ${domainId}`);
    return;
  }

  for (const site of sites) {
    const currentChannels = (site.channels as any) || {};
    let connections = Array.isArray(currentChannels.connections)
      ? [...currentChannels.connections]
      : [];

    let connectionUpdated = false;
    connections = connections.map((conn: any) => {
      if (conn.metadata?.email_domain_id !== domainId) return conn;
      connectionUpdated = true;
      return {
        ...conn,
        metadata: {
          ...conn.metadata,
          domain_status: status,
        },
        updated_at: new Date().toISOString(),
      };
    });

    if (!connectionUpdated) continue;

    const { error: updateError } = await supabaseAdmin
      .from("settings")
      .update({ channels: { ...currentChannels, connections } })
      .eq("site_id", site.site_id);

    if (updateError) {
      console.error("[Zavu Webhook] Error updating domain status:", updateError);
      throw updateError;
    }
    await refreshSiteConfigurationCaches(site.site_id);
  }
}

export async function handleInvitationStatusChanged(data: any) {
  const invitationId = data.invitationId || data.id;
  const currentStatus = data.currentStatus || data.status;
  const senderId = data.senderId || data.newSenderId;
  const connectedAccount = data.connectedAccount || data.wabaAccountId;

  if (!invitationId) {
    console.warn("[Zavu Webhook] invitation.status_changed missing invitationId");
    return;
  }

  console.log(`[Zavu Webhook] Invitation ${invitationId} status changed to ${currentStatus}`);

  const sites = await findSettingsForInvitation(invitationId);
  if (sites.length === 0) {
    console.warn(`[Zavu Webhook] No site found for invitation ${invitationId}`);
    return;
  }

  const site = sites[0];
  const currentChannels = (site.channels as any) || {};
  let connections = Array.isArray(currentChannels.connections)
    ? [...currentChannels.connections]
    : [];

  let connectionUpdated = false;
  connections = connections.map((conn: any) => {
    if (conn.zavu_invitation_id !== invitationId) return conn;
    connectionUpdated = true;
    return {
      ...conn,
      status: mapInvitationStatus(currentStatus),
      zavu_sender_id: senderId || conn.zavu_sender_id,
      connected_account: connectedAccount || conn.connected_account,
      updated_at: new Date().toISOString(),
    };
  });

  if (!connectionUpdated) {
    console.warn(`[Zavu Webhook] Invitation ${invitationId} not found in connections array`);
    return;
  }

  const { error: updateError } = await supabaseAdmin
    .from("settings")
    .update({ channels: { ...currentChannels, connections } })
    .eq("site_id", site.site_id);

  if (updateError) {
    console.error("[Zavu Webhook] Error updating connection status:", updateError);
    throw updateError;
  }
  await refreshSiteConfigurationCaches(site.site_id);

  if (currentStatus === "completed" && senderId) {
    try {
      const updatedSender = await ensureSenderWebhook(senderId);
      const webhook = updatedSender?.webhook;
      if (webhook) {
        const channelConn = connections.find((c: any) => c.zavu_sender_id === senderId || c.zavu_invitation_id === invitationId);
        if (channelConn) {
          const { error: webhookUpdateError } = await supabaseAdmin
            .from("settings")
            .update({
              channels: {
                ...currentChannels,
                connections: connections.map((conn: any) =>
                  conn.id === channelConn.id
                    ? {
                        ...conn,
                        metadata: {
                          ...(conn.metadata || {}),
                          ...(webhook.secret ? { zavu_webhook_secret: encryptToken(webhook.secret) } : {}),
                          zavu_webhook_events: webhook.events || [],
                        },
                      }
                    : conn
                ),
              },
            })
            .eq("site_id", site.site_id);
          if (webhookUpdateError) {
            throw webhookUpdateError;
          }
          await refreshSiteConfigurationCaches(site.site_id);
        }
      }
    } catch (senderError) {
      console.error(`[Zavu Webhook] Failed to configure webhook for sender ${senderId}:`, senderError);
      throw senderError;
    }

    try {
      // For Voice we no longer automatically attach text agents since it's autonomous voice
      // await attachSenderToAgent(senderId);
    } catch (agentError) {
      console.error(`[Zavu Webhook] Failed to attach sender ${senderId} to agent:`, agentError);
    }
  }
}
