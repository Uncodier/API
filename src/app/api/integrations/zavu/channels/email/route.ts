import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createSender, updateSender, attachSenderToAgent, upsertChannelConnection, ensureSenderWebhook, getChannelConnection, requireZavuSiteManager, verifyEmailDomain } from "@/lib/services/zavu";
import { encryptToken } from "@/lib/utils/token-encryption";

const receivingUpdateSchema = z.object({
  siteId: z.string().min(1),
  channelId: z.string().min(1),
  senderId: z.string().min(1),
  emailReceivingEnabled: z.boolean(),
});

const emailConnectionSchema = z.object({
  siteId: z.string().min(1),
  channelId: z.string().min(1),
  name: z.string().trim().min(1).optional(),
  emailAddress: z.string().email(),
  emailFromName: z.string().trim().min(1),
  emailDomainId: z.string().min(1),
});

async function parseJson(request: NextRequest) {
  try {
    return { ok: true as const, value: await request.json() };
  } catch {
    return { ok: false as const };
  }
}

function zavuFailure(operation: string, error: unknown) {
  console.error(`[Zavu] ${operation}:`, error);
  return NextResponse.json(
    { error: `Zavu could not ${operation.toLowerCase()}` },
    { status: 502 }
  );
}

export async function POST(request: NextRequest) {
  try {
    const json = await parseJson(request);
    if (!json.ok) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const parsed = emailConnectionSchema.safeParse(json.value);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid email channel configuration" }, { status: 400 });
    }
    const {
      siteId,
      channelId: existingChannelId,
      name,
      emailAddress,
      emailFromName,
      emailDomainId,
    } = parsed.data;
    await requireZavuSiteManager(request, siteId);

    let sender;
    const existingConnection = await getChannelConnection(siteId, existingChannelId);
    if (existingConnection && existingConnection.type !== "email") {
      return NextResponse.json(
        { error: "Channel connection is not an email channel" },
        { status: 409 }
      );
    }
    if (existingConnection?.zavu_sender_id) {
      try {
        sender = await updateSender(existingConnection.zavu_sender_id, {
          emailAddress,
          emailFromName,
        });
      } catch (error) {
        return zavuFailure("update the email sender", error);
      }
      if (sender?.id !== existingConnection.zavu_sender_id) {
        return NextResponse.json({ error: "Zavu returned a different sender" }, { status: 502 });
      }
      try {
        const webhookSender = await ensureSenderWebhook(existingConnection.zavu_sender_id);
        if (webhookSender?.id === sender.id) sender = { ...sender, ...webhookSender };
      } catch (error) {
        console.warn("[Zavu] Error ensuring webhook on reused sender:", error);
      }
    }

    if (!sender) {
      try {
        sender = await createSender({
          name: name || `Email ${siteId}`,
          emailAddress,
          emailFromName,
          emailDomainId,
          emailReceivingEnabled: false,
        });
      } catch (zavuError: any) {
        return zavuFailure("create the email sender", zavuError);
      }
    }

    if (!sender?.id) {
      return NextResponse.json({ error: "Zavu returned an invalid sender" }, { status: 502 });
    }

    try {
      await attachSenderToAgent(sender.id);
    } catch (agentError) {
      console.error(`[Zavu] Failed to attach sender ${sender.id} to agent:`, agentError);
    }

    const emailChannelActive =
      Array.isArray(sender.channels) && sender.channels.includes("email");
    const { channelId } = await upsertChannelConnection(siteId, existingChannelId, {
      type: "email",
      name: name || "Email Channel",
      status: emailChannelActive ? "connected" : "in_progress",
      zavu_sender_id: sender.id,
      metadata: {
        from_address: emailAddress,
        from_name: emailFromName,
        email_domain_id: emailDomainId,
        emailReceivingEnabled: false,
        emailChannelActive,
        mx_verified: false,
        ...(sender.webhook?.secret ? { zavu_webhook_secret: encryptToken(sender.webhook.secret) } : {}),
        zavu_webhook_events: sender.webhook?.events || [],
      },
    });

    return NextResponse.json({
      success: true,
      channelId,
      senderId: sender.id,
      sender: {
        id: sender.id,
        channels: sender.channels || [],
      },
      webhook: sender.webhook ? {
        url: sender.webhook.url,
        events: sender.webhook.events,
        active: sender.webhook.active,
      } : null,
    });
  } catch (error: any) {
    console.error("[Zavu] Unhandled error in email connect:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: error.status || 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    const json = await parseJson(request);
    if (!json.ok) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const parsed = receivingUpdateSchema.safeParse(json.value);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid email receiving update" }, { status: 400 });
    }
    const { siteId, channelId, senderId, emailReceivingEnabled } = parsed.data;
    await requireZavuSiteManager(request, siteId);

    const connection = await getChannelConnection(siteId, channelId);
    if (!connection) {
      return NextResponse.json({ error: "Email channel connection was not found" }, { status: 404 });
    }
    if (connection.type !== "email" || connection.zavu_sender_id !== senderId) {
      return NextResponse.json(
        { error: "Sender does not match the email channel connection" },
        { status: 409 }
      );
    }

    if (emailReceivingEnabled) {
      const emailDomainId = connection.metadata?.email_domain_id;
      if (!emailDomainId) {
        return NextResponse.json(
          { error: "Email domain is not configured for this channel" },
          { status: 409 }
        );
      }
      try {
        const verifiedDomain = await verifyEmailDomain(emailDomainId);
        if (verifiedDomain?.id && verifiedDomain.id !== emailDomainId) {
          return NextResponse.json(
            { error: "Zavu returned a different email domain" },
            { status: 502 }
          );
        }
        if (verifiedDomain?.status !== "verified") {
          await upsertChannelConnection(siteId, channelId, {
            metadata: {
              domain_status: verifiedDomain?.status || "pending",
              dns_records: verifiedDomain?.dnsRecords || connection.metadata?.dns_records || [],
              mx_verified: false,
            },
          });
          return NextResponse.json(
            {
              error: "The MX record is not verified in Zavu yet. Check DNS propagation and retry Verify MX.",
              domain: verifiedDomain,
            },
            { status: 409 }
          );
        }
      } catch (zavuError) {
        return zavuFailure("verify the MX record before enabling receiving", zavuError);
      }
    }

    let sender;
    try {
      sender = await updateSender(senderId, {
        emailReceivingEnabled,
      });
    } catch (zavuError: any) {
      return zavuFailure("update email receiving", zavuError);
    }

    if (sender?.id !== senderId || typeof sender?.emailReceivingEnabled !== "boolean") {
      return NextResponse.json(
        { error: "Zavu did not confirm the email receiving update" },
        { status: 502 }
      );
    }

    const applied = sender.emailReceivingEnabled;

    await upsertChannelConnection(siteId, channelId, {
      metadata: {
        emailReceivingEnabled: applied,
        ...(emailReceivingEnabled ? { mx_verified: applied } : {}),
      },
    });

    return NextResponse.json({ success: true, sender });
  } catch (error: any) {
    console.error("[Zavu] Unhandled error in email patch:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: error.status || 500 }
    );
  }
}
