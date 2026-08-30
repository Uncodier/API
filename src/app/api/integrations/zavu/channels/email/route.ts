import { NextRequest, NextResponse } from "next/server";
import { createSender, updateSender, attachSenderToAgent, upsertChannelConnection, ensureSenderWebhook, getChannelConnection } from "@/lib/services/zavu";
import { encryptToken } from "@/lib/utils/token-encryption";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      siteId,
      channelId: existingChannelId,
      name,
      emailAddress,
      emailFromName,
      emailDomainId,
    } = body;

    if (!siteId) {
      return NextResponse.json({ error: "siteId is required" }, { status: 400 });
    }

    if (!emailAddress) {
      return NextResponse.json({ error: "emailAddress is required" }, { status: 400 });
    }

    let sender;
    const existingConnection = await getChannelConnection(siteId, existingChannelId);
    if (existingConnection?.zavu_sender_id) {
      sender = { id: existingConnection.zavu_sender_id };
      try {
        await updateSender(existingConnection.zavu_sender_id, {
          emailAddress,
          emailFromName,
        });
        sender = await ensureSenderWebhook(existingConnection.zavu_sender_id);
      } catch (err) {
        console.warn("[Zavu] Error ensuring webhook on reused sender:", err);
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
        console.error("[Zavu] Error creating sender for Email:", zavuError);
        const errorMessage = `Zavu API Error: ${zavuError.message || "Unknown error"}`;
        return NextResponse.json(
          { error: errorMessage },
          { status: zavuError.status || 502 }
        );
      }
    }

    try {
      await attachSenderToAgent(sender.id);
    } catch (agentError) {
      console.error(`[Zavu] Failed to attach sender ${sender.id} to agent:`, agentError);
    }

    const { channelId } = await upsertChannelConnection(siteId, existingChannelId, {
      type: "email",
      name: name || "Email Channel",
      status: "connected",
      zavu_sender_id: sender.id,
      metadata: {
        from_address: emailAddress,
        from_name: emailFromName,
        email_domain_id: emailDomainId,
        emailReceivingEnabled: false,
        mx_verified: false,
        ...(sender.webhook?.secret ? { zavu_webhook_secret: encryptToken(sender.webhook.secret) } : {}),
        zavu_webhook_events: sender.webhook?.events || [],
      },
    });

    return NextResponse.json({
      success: true,
      channelId,
      senderId: sender.id,
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
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { siteId, channelId, senderId, emailReceivingEnabled } = body;

    if (!siteId || !channelId || !senderId) {
      return NextResponse.json({ error: "siteId, channelId, and senderId are required" }, { status: 400 });
    }

    try {
      await updateSender(senderId, {
        emailReceivingEnabled: !!emailReceivingEnabled,
      });
    } catch (zavuError: any) {
      console.error("[Zavu] Error updating sender for Email:", zavuError);
      return NextResponse.json(
        { error: `Zavu API Error: ${zavuError.message || "Unknown error"}` },
        { status: zavuError.status || 502 }
      );
    }

    await upsertChannelConnection(siteId, channelId, {
      metadata: {
        emailReceivingEnabled: !!emailReceivingEnabled,
      },
    });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("[Zavu] Unhandled error in email patch:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
