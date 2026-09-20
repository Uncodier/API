import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  assignPhoneNumberToSender,
  assertPhoneResourcesAvailable,
  createSender,
  createVoiceSender,
  deleteSender,
  ensureProjectWebhook,
  ensureSenderWebhook,
  ensureVoiceSender,
  getChannelConnection,
  getOwnedNumbers,
  purchaseNumber,
  requireZavuSiteAccess,
  requireZavuSiteManager,
  syncConnectedCustomerSupportVoiceAgent,
  syncCustomerSupportVoiceAgentWithTools,
  updateAgent,
  updateSender,
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

function getRegulatoryStatus(phone: any): string | undefined {
  return phone?.regulatoryStatus || phone?.regulatory_status || phone?.regulatory?.status;
}

type ResolvedVoiceSender = {
  sender: any;
  phone: any;
  createdSender: boolean;
  replacedSenderId?: string;
  voiceWasEnabled: boolean;
};

async function resolveSender(
  input: z.infer<typeof voiceRequestSchema>
): Promise<ResolvedVoiceSender> {
  const existingConnection = await getChannelConnection(input.siteId, input.channelId);
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
    phone =
      (purchased?.item && typeof purchased.item === "object" && purchased.item) ||
      (purchased?.phoneNumber &&
        typeof purchased.phoneNumber === "object" &&
        purchased.phoneNumber) ||
      purchased;
    await assertPhoneResourcesAvailable(input.siteId, {
      id: phone?.id,
      phoneNumber: input.phoneNumber,
      senderId: phone?.senderId,
    });
  }
  const persistedPreviousSenderId =
    typeof existingConnection?.metadata?.previous_sender_id === "string"
      ? existingConnection.metadata.previous_sender_id
      : undefined;
  const existingSenderId =
    typeof existingConnection?.zavu_sender_id === "string"
      ? existingConnection.zavu_sender_id
      : undefined;
  const staleSenderId =
    persistedPreviousSenderId && persistedPreviousSenderId !== phone?.senderId
      ? persistedPreviousSenderId
      : existingSenderId && existingSenderId !== phone?.senderId
        ? existingSenderId
        : undefined;

  if (phone?.senderId) {
    try {
      const sender = await ensureSenderWebhook(phone.senderId);
      return {
        sender,
        phone,
        createdSender: false,
        replacedSenderId: staleSenderId,
        voiceWasEnabled:
          Array.isArray(sender.channels) && sender.channels.includes("voice"),
      };
    } catch (error: any) {
      if (error?.status !== 404) throw error;
      console.warn(
        `[Zavu Voice] Phone ${input.phoneNumber} references missing sender ${phone.senderId}; creating a replacement`
      );
    }
  }

  const name = input.name || `Voice ${input.siteId}`;
  if (!phone?.senderId) {
    return {
      sender: await createVoiceSender({ name, phoneNumber: input.phoneNumber }),
      phone,
      createdSender: true,
      replacedSenderId: staleSenderId,
      voiceWasEnabled: false,
    };
  }

  if (!phone?.id) {
    throw new Error("The owned phone number is missing its Zavu ID");
  }

  const replacement = await createSender({ name, enableSmsOneway: true });
  try {
    await assignPhoneNumberToSender(phone.id, replacement.id);
    return {
      sender: replacement,
      phone: { ...phone, senderId: replacement.id },
      createdSender: true,
      replacedSenderId: phone.senderId as string,
      voiceWasEnabled: false,
    };
  } catch (error) {
    try {
      await deleteSender(replacement.id);
    } catch (cleanupError) {
      console.error(
        `[Zavu Voice] Failed to remove replacement sender ${replacement.id}:`,
        cleanupError
      );
    }
    throw error;
  }
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

    let resolved: Awaited<ReturnType<typeof resolveSender>> | undefined;
    let synced: Awaited<ReturnType<typeof syncCustomerSupportVoiceAgentWithTools>> | undefined;
    let staged: Awaited<ReturnType<typeof upsertChannelConnection>> | undefined;
    let voiceActivationAttempted = false;
    try {
      resolved = await resolveSender(input);
      const regulatoryStatus = getRegulatoryStatus(resolved.phone);
      const stagedPatch = {
        type: "voice",
        name: input.name || "Voice Channel",
        zavu_sender_id: resolved.sender.id,
        metadata: {
          phone_number: input.phoneNumber,
          phone_number_id: resolved.phone?.id,
          regulatory_status: regulatoryStatus,
          activation_pending: true,
          webhook_events: resolved.sender.webhook?.events || [],
          previous_sender_id: resolved.replacedSenderId,
        },
      };
      staged = await upsertChannelConnection(input.siteId, input.channelId, {
        ...stagedPatch,
        status: "in_progress",
      });

      synced = await syncCustomerSupportVoiceAgentWithTools({
        siteId: input.siteId,
        senderIds: [resolved.sender.id],
        activate: false,
      });
      const connectionPatch = {
        ...stagedPatch,
        metadata: {
          ...stagedPatch.metadata,
          zavu_agent_id: synced.agent.id,
        },
      };
      const agent = await updateAgent(synced.agent.id, {
        enabled: synced.shouldEnable,
      });
      voiceActivationAttempted = synced.shouldEnable && !resolved.voiceWasEnabled;
      const sender = synced.shouldEnable
        ? await ensureVoiceSender(resolved.sender.id)
        : resolved.sender;
      let persisted = staged;
      if (synced.shouldEnable) {
        persisted = await upsertChannelConnection(
          input.siteId,
          staged.channelId,
          {
            ...connectionPatch,
            status: regulatoryStatus === "pending_review" ? "in_progress" : "connected",
            metadata: {
              ...connectionPatch.metadata,
              activation_pending: false,
              webhook_events: sender.webhook?.events || [],
              previous_sender_id: undefined,
            },
          },
          resolved.replacedSenderId
            ? {
                replaceSender: {
                  previousSenderId: resolved.replacedSenderId,
                  replacementSenderId: sender.id,
                },
              }
            : undefined
        );
      } else {
        persisted = await upsertChannelConnection(
          input.siteId,
          staged.channelId,
          {
            ...connectionPatch,
            status: "pending",
          },
          resolved.replacedSenderId
            ? {
                replaceSender: {
                  previousSenderId: resolved.replacedSenderId,
                  replacementSenderId: resolved.sender.id,
                },
              }
            : undefined
        );
      }

      return NextResponse.json({
        success: true,
        channelId: persisted.channelId,
        connection: persisted.connection,
        connections: persisted.connections,
        senderId: sender.id,
        phoneNumberId: resolved.phone?.id,
        regulatoryStatus,
        zavuAgentId: agent.id,
        agentEnabled: agent.enabled,
      });
    } catch (zavuError: any) {
      if (voiceActivationAttempted && resolved && !resolved.voiceWasEnabled) {
        try {
          await updateSender(resolved.sender.id, { enableVoice: false });
        } catch (rollbackError) {
          console.error(
            `[Zavu Voice] Failed to disable sender ${resolved.sender.id} during rollback:`,
            rollbackError
          );
        }
      }
      if (synced) {
        try {
          await updateAgent(synced.agent.id, { enabled: synced.previousEnabled });
        } catch (rollbackError) {
          console.error(
            `[Zavu Voice] Failed to restore agent ${synced.agent.id} during rollback:`,
            rollbackError
          );
        }
      }
      if (resolved?.createdSender && !resolved.replacedSenderId && !staged) {
        try {
          await deleteSender(resolved.sender.id);
        } catch (cleanupError) {
          console.error(
            `[Zavu Voice] Failed to remove staged sender ${resolved.sender.id}:`,
            cleanupError
          );
        }
      }
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
