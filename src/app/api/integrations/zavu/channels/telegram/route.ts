import { NextRequest, NextResponse } from "next/server";
import { createSender, connectTelegram, attachSenderToAgent, upsertChannelConnection } from "@/lib/services/zavu";

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

    const webhookUrl = `${process.env.API_SERVER_URL || process.env.NEXT_PUBLIC_API_SERVER_URL}/api/integrations/zavu/webhook`;

    let sender;
    try {
      sender = await createSender({
        name: name || `Telegram ${siteId}`,
        enableSmsOneway: true,
        webhookUrl,
        webhookEvents: ["message.inbound"],
      });
    } catch (zavuError: any) {
      console.error("[Zavu] Error creating sender for Telegram:", zavuError);
      return NextResponse.json(
        { error: `Zavu API Error (create sender): ${zavuError.message || "Unknown error"}` },
        { status: zavuError.status || 502 }
      );
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
        zavu_webhook_secret: sender.webhookSecret,
      },
    });

    return NextResponse.json({
      success: true,
      channelId,
      senderId: sender.id,
      telegram,
    });
  } catch (error: any) {
    console.error("[Zavu] Unhandled error in telegram connect:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
