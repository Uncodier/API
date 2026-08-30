import { NextRequest, NextResponse, after } from "next/server";
import {
  attachSenderToAgent,
  mapInvitationStatus,
  updateSenderWebhook,
  verifyZavuSignature,
} from "@/lib/services/zavu";
import { supabaseAdmin } from "@/lib/database/supabase-server";
import { decryptToken } from "@/lib/utils/token-decryption";
import { encryptToken } from "@/lib/utils/token-encryption";
import { WorkflowService } from "@/lib/services/workflow-service";

export async function POST(request: NextRequest) {
  try {
    const signature = request.headers.get("x-zavu-signature");
    const rawBody = await request.text();
    let secret = process.env.ZAVUDEV_WEBHOOK_SECRET;

    // Parse early only to inspect senderId (this doesn't affect signature checking against rawBody)
    let event: any = {};
    try {
      event = JSON.parse(rawBody);
    } catch (e) {
      console.error("[Zavu Webhook] Failed to parse body", e);
    }

    // Since every created sender has its own webhook secret, we look it up from the DB
    const senderId = event.senderId || event.data?.senderId || event.sender?.id;
    if (senderId) {
      const sites = await findSettingsForSender(senderId);
      if (sites.length > 0) {
        const site = sites[0];
        const connections = (site.channels as any)?.connections || [];
        const conn = connections.find((c: any) => c.zavu_sender_id === senderId);
        if (conn?.metadata?.zavu_webhook_secret) {
          console.log(`[Zavu Webhook] Secret stored in DB: ${conn.metadata.zavu_webhook_secret.substring(0, 10)}...`);
          const decrypted = decryptToken(conn.metadata.zavu_webhook_secret);
          secret = decrypted || conn.metadata.zavu_webhook_secret;
          console.log(`[Zavu Webhook] Found specific secret for sender ${senderId} (decrypted: ${!!decrypted})`);
        } else {
          console.log(`[Zavu Webhook] No secret stored for sender ${senderId}, falling back to env var`);
        }
      } else {
        console.log(`[Zavu Webhook] Site not found for sender ${senderId}`);
      }
    } else {
      console.log(`[Zavu Webhook] No senderId in event payload`);
    }

    // Acknowledge immediately before slow verifications or processing, to keep it async like Vercel needs
    // But we need to verify signature first before trusting the payload
    if (!verifyZavuSignature(signature, rawBody, secret)) {
      console.warn("[Zavu Webhook] Invalid signature");
      return new NextResponse("Invalid signature", { status: 401 });
    }

    const eventType = event.type || (event.data?.text && event.data?.from ? "message.inbound" : undefined);
    event.type = eventType;
    console.log(`[Zavu Webhook] Received event: ${eventType || "unknown"}`);

    after(() =>
      processEventAsync(event).catch((error) => {
        console.error("[Zavu Webhook] Async processing error:", error);
      })
    );

    return new NextResponse("OK", { status: 200 });
  } catch (error) {
    console.error("[Zavu Webhook] Error handling webhook:", error);
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}

async function processEventAsync(event: any) {
  switch (event.type) {
    case "invitation.status_changed":
      await handleInvitationStatusChanged(event.data || {});
      break;
    case "domain.verified":
    case "domain.failed":
      await handleDomainStatusChanged(event.data || {}, event.type);
      break;
    case "message.inbound":
      console.log(`[Zavu Webhook] Inbound message on ${event.data?.channel || "unknown"}`);
      await handleInboundMessage(event);
      break;
    default:
      console.log(`[Zavu Webhook] Unhandled event type: ${event.type}`);
  }
}

async function findSettingsForDomain(domainId: string) {
  const { data, error } = await supabaseAdmin
    .from("settings")
    .select("id, site_id, channels")
    .contains("channels", {
      connections: [{ metadata: { email_domain_id: domainId } }],
    });

  if (error) {
    console.error("[Zavu Webhook] DB error finding domain:", error);
    return [];
  }

  return data || [];
}

async function handleDomainStatusChanged(data: any, eventType: string) {
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
    }
  }
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
    return [];
  }

  return data || [];
}

async function findSettingsForSender(senderId: string) {
  const { data, error } = await supabaseAdmin
    .from("settings")
    .select("id, site_id, channels")
    .contains("channels", {
      connections: [{ zavu_sender_id: senderId }],
    });

  if (error) {
    console.error("[Zavu Webhook] DB error finding sender:", error);
    return [];
  }

  return data || [];
}

async function getUserIdFromSite(siteId: string): Promise<string | undefined> {
  const { data } = await supabaseAdmin.from("sites").select("user_id").eq("id", siteId).maybeSingle();
  return data?.user_id || undefined;
}

async function handleInboundMessage(event: any) {
  const data = event.data;
  if (!data || !data.from) {
    console.warn("[Zavu Webhook] Inbound event missing data.from");
    return;
  }

  const messageText = data.text || data.body || data.caption;
  if (!messageText) {
    console.warn("[Zavu Webhook] Inbound event missing message text");
    return;
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
  const channel = data.channel || "zavu";
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
  }
}

async function handleInvitationStatusChanged(data: any) {
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
    return;
  }

  if (currentStatus === "completed" && senderId) {
    const webhookUrl = `${process.env.API_SERVER_URL || process.env.NEXT_PUBLIC_API_SERVER_URL}/api/integrations/zavu/webhook`;
    try {
      const updatedSender = await updateSenderWebhook(senderId, webhookUrl);
      if (updatedSender && (updatedSender as any).webhook?.secret) {
        // Find the channel again to get its current state and update metadata
        const channelConn = connections.find((c: any) => c.zavu_sender_id === senderId || c.zavu_invitation_id === invitationId);
        if (channelConn) {
          await supabaseAdmin
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
                          zavu_webhook_secret: encryptToken((updatedSender as any).webhook.secret),
                        },
                      }
                    : conn
                ),
              },
            })
            .eq("site_id", site.site_id);
        }
      }
    } catch (senderError) {
      console.error(`[Zavu Webhook] Failed to configure webhook for sender ${senderId}:`, senderError);
    }

    try {
      await attachSenderToAgent(senderId);
    } catch (agentError) {
      console.error(`[Zavu Webhook] Failed to attach sender ${senderId} to agent:`, agentError);
    }
  }
}
