import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  assignNumberToSender,
  assertPhoneResourcesAvailable,
  createSender,
  ensureProjectWebhook,
  ensureSenderWebhook,
  getOwnedNumbers,
  purchaseNumber,
  requireZavuSiteAccess,
  requireZavuSiteManager,
  syncConnectedCustomerSupportVoiceAgent,
  syncCustomerSupportVoiceAgent,
  syncVoiceTools,
  upsertChannelConnection,
} from "@/lib/services/zavu";

const voiceRequestSchema = z.object({
  siteId: z.string().uuid(),
  channelId: z.string().uuid().optional(),
  name: z.string().trim().max(100).optional(),
  phoneNumber: z.string().trim().min(5).max(30),
  active: z.boolean().optional(),
}).strict();

function unwrapPhoneNumbers(payload: any): any[] {
  return payload?.items || payload?.results || (Array.isArray(payload) ? payload : []);
}

async function resolveSender(input: z.infer<typeof voiceRequestSchema>) {
  let phone = unwrapPhoneNumbers(await getOwnedNumbers())
    .find((item) => item.phoneNumber === input.phoneNumber);
  if (phone) {
    await assertPhoneResourcesAvailable(input.siteId, {
      id: phone.id,
      phoneNumber: phone.phoneNumber,
      senderId: phone.senderId,
    });
  }
  if (!phone) {
    const purchased = await purchaseNumber(input.phoneNumber);
    phone = purchased?.phoneNumber || purchased;
    await assertPhoneResourcesAvailable(input.siteId, {
      id: phone?.id,
      phoneNumber: input.phoneNumber,
      senderId: phone?.senderId,
    });
  }
  if (phone?.senderId) {
    return { sender: await ensureSenderWebhook(phone.senderId), phone };
  }

  const sender = await createSender({
    name: input.name || `Voice ${input.siteId}`,
    enableSmsOneway: true,
  });
  await assignNumberToSender(sender.id, input.phoneNumber);
  return { sender, phone };
}

export async function POST(request: NextRequest) {
  try {
    const parsed = voiceRequestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid Voice configuration" }, { status: 400 });
    }
    const input = parsed.data;
    await requireZavuSiteManager(request, input.siteId);

    try {
      await ensureProjectWebhook();
    } catch (whError) {
      console.warn("[Zavu Voice] Failed to ensure project webhook:", whError);
    }

    try {
      const { sender, phone } = await resolveSender(input);
      const synced = await syncCustomerSupportVoiceAgent({
        siteId: input.siteId,
        senderIds: [sender.id],
      });
      await syncVoiceTools({
        agentId: synced.agent.id,
        siteId: input.siteId,
        webhookSecret: synced.webhookSecret,
      });

      const { channelId } = await upsertChannelConnection(input.siteId, input.channelId, {
        type: "voice",
        name: input.name || "Voice Channel",
        status: "connected",
        zavu_sender_id: sender.id,
        metadata: {
          phone_number: input.phoneNumber,
          phone_number_id: phone?.id,
          zavu_agent_id: synced.agent.id,
          webhook_events: sender.webhook?.events || [],
        },
      });

      return NextResponse.json({
        success: true,
        channelId,
        senderId: sender.id,
        zavuAgentId: synced.agent.id,
        agentEnabled: synced.agent.enabled,
      });
    } catch (zavuError: any) {
      console.error("[Zavu Voice] Error creating sender:", zavuError);
      return NextResponse.json(
        { error: `Zavu API Error: ${zavuError.message || "Unknown error"}` },
        { status: zavuError.status || 502 }
      );
    }
  } catch (error: any) {
    console.error("[Zavu Voice] Unhandled error in create voice channel:", error);
    return NextResponse.json(
      { error: error.status ? error.message : "Internal server error" },
      { status: error.status || 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = z.object({ siteId: z.string().uuid() }).safeParse(await request.json());
    if (!body.success) {
      return NextResponse.json({ error: "Invalid siteId" }, { status: 400 });
    }
    await requireZavuSiteAccess(request, body.data.siteId);

    const synced = await syncConnectedCustomerSupportVoiceAgent(body.data.siteId);
    return NextResponse.json({
      success: true,
      synced,
    });
  } catch (error: any) {
    console.error("[Zavu Voice] Agent sync failed:", error);
    return NextResponse.json(
      { error: error.status ? error.message : "Failed to sync Voice agent" },
      { status: error.status || 500 }
    );
  }
}
