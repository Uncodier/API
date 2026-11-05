import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createSender, connectTelegram, attachSenderToAgent, upsertChannelConnection, ensureSenderWebhook, getChannelConnection, requireZavuSiteManager, ensureSenderChannelActive, isChannelActivationBlocked } from "@/lib/services/zavu";
import { encryptToken } from "@/lib/utils/token-encryption";
import { patchActivationConnection, requireActivationLicense } from "@/lib/services/zavu/activation-persistence";

const connectionSchema = z.object({
  siteId: z.string().trim().min(1),
  channelId: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  botToken: z.string().trim().min(1).max(512),
});

export async function POST(request: NextRequest) {
  let channelId: string | undefined;
  let senderId: string | undefined;
  let authorized = false;
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const parsed = connectionSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid Telegram channel configuration" }, { status: 400 });
    }
    const { siteId, channelId: existingChannelId, name, botToken } = parsed.data;
    await requireZavuSiteManager(request, siteId);
    authorized = true;
    const existing = await getChannelConnection(siteId, existingChannelId);
    if (existing && existing.type !== "telegram") {
      return NextResponse.json({ error: "Channel connection is not a Telegram channel" }, { status: 409 });
    }
    if (isChannelActivationBlocked(existing)) {
      return NextResponse.json({ error: "Channel connection is disabled or license-suspended" }, { status: 409 });
    }

    if (existing) await requireActivationLicense(siteId, existingChannelId!, {
      type: "telegram", senderId: existing.zavu_sender_id || null,
    });
    let sender = existing?.zavu_sender_id
      ? { id: existing.zavu_sender_id } as Awaited<ReturnType<typeof createSender>>
      : await createSender({ name: name || `Telegram ${siteId}`, enableSmsOneway: true });
    if (!sender?.id) throw new Error("Invalid sender");
    senderId = sender.id;
    // Save the remote identity before further provider operations so retries reuse it.
    const pending = {
      type: "telegram",
      name: name || existing?.name || "Telegram Channel",
      status: existing?.status === "connected" ? "connected" : "in_progress",
      zavu_sender_id: sender.id,
      metadata: {
        activation_pending: true,
        ...(sender.webhook?.secret ? { zavu_webhook_secret: encryptToken(sender.webhook.secret) } : {}),
      },
    };
    if (existing) {
      channelId = existingChannelId!;
      await patchActivationConnection(siteId, channelId, pending, {
        type: "telegram", senderId: existing.zavu_sender_id || null,
      });
    } else {
      ({ channelId } = await upsertChannelConnection(siteId, existingChannelId, pending));
    }
    const expected = { senderId: sender.id, type: "telegram" };
    if (existing?.zavu_sender_id) {
      sender = await ensureSenderWebhook(sender.id);
      if (sender?.id !== senderId) throw new Error("Invalid webhook sender");
    }
    const telegramConn = await connectTelegram(sender.id, botToken);
    const telegram = telegramConn?.telegram || telegramConn;
    await patchActivationConnection(siteId, channelId!, {
      metadata: {
        bot_username: telegram?.botUsername,
        bot_id: telegram?.botId,
        ...(sender.webhook?.secret ? { zavu_webhook_secret: encryptToken(sender.webhook.secret) } : {}),
        zavu_webhook_events: sender.webhook?.events || [],
      },
    }, expected);
    await requireActivationLicense(siteId, channelId!, expected);
    await ensureSenderChannelActive(sender.id, "telegram");
    try {
      await attachSenderToAgent(sender.id);
    } catch {
      console.warn("[Zavu] Could not attach Telegram sender to agent");
    }
    await requireActivationLicense(siteId, channelId!, expected);
    await patchActivationConnection(siteId, channelId!, {
      status: "connected",
      metadata: { activation_pending: false, provider_channel_active: true },
    }, expected);
    return NextResponse.json({
      success: true, channelId, senderId: sender.id,
      telegram: { botUsername: telegram?.botUsername, botId: telegram?.botId },
      webhook: sender.webhook ? {
        url: sender.webhook.url, events: sender.webhook.events, active: sender.webhook.active,
      } : null,
    });
  } catch (error: any) {
    const status = !authorized && (error?.status === 401 || error?.status === 403) ? error.status : 502;
    return NextResponse.json({
      error: status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Zavu could not connect and activate the Telegram channel",
      ...(channelId ? { channelId, senderId } : {}),
    }, { status });
  }
}
