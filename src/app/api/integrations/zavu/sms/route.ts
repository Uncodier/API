import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  assertPhoneResourcesAvailable,
  assignNumberToSender,
  attachSenderToAgent,
  createSender,
  ensureEncryptedSenderWebhookSecret,
  ensureProjectWebhook,
  purchaseNumber,
  requireZavuSiteManager,
  upsertChannelConnection,
} from "@/lib/services/zavu";

export async function POST(request: NextRequest) {
  try {
    const parsed = z.object({
      siteId: z.string().uuid(),
      channelId: z.string().uuid().optional(),
      name: z.string().trim().max(100).optional(),
      phoneNumber: z.string().trim().min(5).max(30).optional(),
      active: z.boolean().optional(),
    }).strict().safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid SMS configuration" }, { status: 400 });
    }
    const { siteId, channelId, name, phoneNumber } = parsed.data;
    await requireZavuSiteManager(request, siteId);
    if (phoneNumber) {
      await assertPhoneResourcesAvailable(siteId, { phoneNumber });
    }

    try {
      await ensureProjectWebhook();
    } catch (whError) {
      console.warn("[Zavu SMS] Failed to ensure project webhook:", whError);
    }

    // Create a generic sender for SMS
    let sender;
    try {
      if (phoneNumber) {
        try {
          await purchaseNumber(phoneNumber);
        } catch (e: any) {
          console.warn("[Zavu SMS] Number might already be purchased or error buying:", e.message);
        }
      }

      sender = await createSender({
        name: name || `SMS Agent for Site ${siteId}`,
        enableSmsOneway: true // Required by Zavu when creating a sender without an initial phone number
      });
      
      if (phoneNumber) {
        await assignNumberToSender(sender.id, phoneNumber);
      }
      
      await attachSenderToAgent(sender.id);
    } catch (zavuError: any) {
      console.error("[Zavu SMS] Error creating sender:", zavuError);
      return NextResponse.json(
        { error: `Zavu API Error: ${zavuError.message || "Unknown error"}` },
        { status: 502 }
      );
    }

    const encryptedWebhookSecret =
      await ensureEncryptedSenderWebhookSecret({
        senderId: sender.id,
        returnedSecret: sender.webhook?.secret,
      });
    const { channelId: persistedChannelId } = await upsertChannelConnection(
      siteId,
      channelId,
      {
        type: "sms",
        name: name || "SMS Channel",
        status: "connected",
        zavu_sender_id: sender.id,
        metadata: {
          phone_number: phoneNumber,
          zavu_webhook_secret: encryptedWebhookSecret,
          webhook_events: sender.webhook?.events || [],
        },
      }
    );

    return NextResponse.json({
      success: true,
      channelId: persistedChannelId,
      senderId: sender.id,
    });
  } catch (error: any) {
    console.error("[Zavu SMS] Unhandled error in create SMS channel:", error);
    return NextResponse.json(
      { error: error.status ? error.message : "Internal server error" },
      { status: error.status || 500 }
    );
  }
}
