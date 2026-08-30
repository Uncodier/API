import { NextRequest, NextResponse } from "next/server";
import { createSender, connectTelegram, attachSenderToAgent, upsertChannelConnection, ensureSenderWebhook, getChannelConnection } from "@/lib/services/zavu";
import { encryptToken } from "@/lib/utils/token-encryption";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { siteId, channelId: existingChannelId, name, botToken } = body;

    if (!siteId) {
      return NextResponse.json({ error: "siteId is required" }, { status: 400 });
    }

    if (!botToken) {
      return NextResponse.json({ error: "botToken is required" }, { status: 400 });
    }

    let sender;
    const existingConnection = await getChannelConnection(siteId, existingChannelId);
    if (existingConnection?.zavu_sender_id) {
      sender = { id: existingConnection.zavu_sender_id };
      try {
        sender = await ensureSenderWebhook(existingConnection.zavu_sender_id);
      } catch (err) {
        console.warn("[Zavu] Error ensuring webhook on reused sender:", err);
      }
    }

    if (!sender) {
      try {
        sender = await createSender({
          name: name || `Telegram ${siteId}`,
          enableSmsOneway: true,
        });
      } catch (zavuError: any) {
        console.error("[Zavu] Error creating sender for Telegram:", zavuError);
        return NextResponse.json(
          { error: `Zavu API Error (create sender): ${zavuError.message || "Unknown error"}` },
          { status: zavuError.status || 502 }
        );
      }
    }

    let telegramConn;
    try {
      telegramConn = await connectTelegram(sender.id, botToken);
    } catch (zavuError: any) {
      console.error("[Zavu] Error connecting Telegram:", zavuError);
      
      const errorMessage = zavuError.message === "Not Found" 
        ? "Invalid Telegram Bot Token. Please verify the token." 
        : `Zavu API Error: ${zavuError.message || "Unknown error"}`;
        
      return NextResponse.json(
        { error: errorMessage },
        { status: zavuError.status === 400 ? 400 : 502 }
      );
    }

    try {
      await attachSenderToAgent(sender.id);
    } catch (agentError) {
      console.error(`[Zavu] Failed to attach sender ${sender.id} to agent:`, agentError);
    }

    const telegram = telegramConn?.telegram || telegramConn;
    const { channelId } = await upsertChannelConnection(siteId, existingChannelId, {
      type: "telegram",
      name: name || "Telegram Channel",
      status: "connected",
      zavu_sender_id: sender.id,
      metadata: {
        bot_username: telegram?.botUsername,
        bot_id: telegram?.botId,
        ...(sender.webhook?.secret ? { zavu_webhook_secret: encryptToken(sender.webhook.secret) } : {}),
        zavu_webhook_events: sender.webhook?.events || [],
      },
    });

    return NextResponse.json({
      success: true,
      channelId,
      senderId: sender.id,
      telegram,
      webhook: sender.webhook ? {
        url: sender.webhook.url,
        events: sender.webhook.events,
        active: sender.webhook.active,
      } : null,
    });
  } catch (error: any) {
    console.error("[Zavu] Unhandled error in telegram connect:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
