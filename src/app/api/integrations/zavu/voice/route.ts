import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  assignPhoneNumberToSender,
  assertPhoneResourcesAvailable,
  createSender,
  createVoiceSender,
  deleteSender,
  ensureEncryptedSenderWebhookSecret,
  ensureProjectWebhook,
  ensureSenderWebhook,
  ensureVoiceSender,
  getChannelConnection,
  getCustomerSupportVoicePreferences,
  getOwnedNumbers,
  listAgentVoices,
  mergeVoiceAgentPreferences,
  purchaseNumber,
  requireZavuSiteAccess,
  requireZavuSiteManager,
  restoreChannelConnections,
  rollbackConnectedVoiceAgentSync,
  rollbackVoiceAgentSynchronization,
  syncConnectedCustomerSupportVoiceAgent,
  syncConnectedCustomerSupportVoiceAgentDetailed,
  syncCustomerSupportVoiceAgentWithTools,
  updateAgent,
  updateAllVoiceConnectionPreferences,
  updateCustomerSupportVoicePreferences,
  updateSender,
  upsertChannelConnection,
  validateVoiceAgentPreferences,
} from "@/lib/services/zavu";
import {
  hasVoicePreferencesPatch,
  voiceRequestSchema,
  voiceSyncRequestSchema,
} from "@/lib/services/zavu/voice-route-preferences";

async function resolveVoicePreferences(
  siteId: string,
  patch: { language?: string; ttsVoiceId?: string | null }
) {
  const current = await getCustomerSupportVoicePreferences(siteId);
  if (!hasVoicePreferencesPatch(patch)) {
    return { current, desired: current, changed: false };
  }
  const desired = mergeVoiceAgentPreferences(current, patch);
  validateVoiceAgentPreferences(desired, await listAgentVoices());
  return {
    current,
    desired,
    changed:
      current.language !== desired.language ||
      current.ttsVoiceId !== desired.ttsVoiceId,
  };
}

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
  encryptedWebhookSecret?: string;
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
        encryptedWebhookSecret:
          existingSenderId === phone.senderId
          && typeof existingConnection?.metadata?.zavu_webhook_secret === "string"
            ? existingConnection.metadata.zavu_webhook_secret
            : undefined,
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
    let preferencesState: Awaited<ReturnType<typeof resolveVoicePreferences>> | undefined;
    let preferencesPersisted = false;
    let finalConnectionPersisted = false;
    let voiceActivationAttempted = false;
    try {
      preferencesState = await resolveVoicePreferences(input.siteId, input);
      const { current: currentPreferences, desired: voicePreferences } =
        preferencesState;
      resolved = await resolveSender(input);
      const encryptedWebhookSecret =
        await ensureEncryptedSenderWebhookSecret({
          senderId: resolved.sender.id,
          returnedSecret: resolved.sender.webhook?.secret,
          encryptedSecret: resolved.encryptedWebhookSecret,
        });
      const regulatoryStatus = getRegulatoryStatus(resolved.phone);
      const regulatoryDeferred = [
        "pending",
        "pending_review",
        "in_review",
        "under_review",
      ].includes(regulatoryStatus || "");
      const stagedPatch = {
        type: "voice",
        name: input.name || "Voice Channel",
        zavu_sender_id: resolved.sender.id,
        metadata: {
          phone_number: input.phoneNumber,
          phone_number_id: resolved.phone?.id,
          regulatory_status: regulatoryStatus,
          activation_pending: true,
          zavu_webhook_secret: encryptedWebhookSecret,
          webhook_events: resolved.sender.webhook?.events || [],
          previous_sender_id: resolved.replacedSenderId,
          voice_language: currentPreferences.language,
          tts_voice_id: currentPreferences.ttsVoiceId || null,
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
        voicePreferences,
      });
      const connectionPatch = {
        ...stagedPatch,
        metadata: {
          ...stagedPatch.metadata,
          zavu_agent_id: synced.agent.id,
          voice_language: voicePreferences.language,
          tts_voice_id: voicePreferences.ttsVoiceId || null,
        },
      };
      const agent = await updateAgent(synced.agent.id, {
        enabled: synced.shouldEnable,
      });
      const shouldActivateSender = synced.shouldEnable && !regulatoryDeferred;
      voiceActivationAttempted =
        shouldActivateSender && !resolved.voiceWasEnabled;
      const sender = shouldActivateSender
        ? await ensureVoiceSender(resolved.sender.id)
        : resolved.sender;
      if (preferencesState.changed) {
        await updateCustomerSupportVoicePreferences(input.siteId, {
          language: voicePreferences.language,
          ttsVoiceId: voicePreferences.ttsVoiceId || null,
        });
        preferencesPersisted = true;
      }
      let persisted = staged;
      if (synced.shouldEnable) {
        persisted = await upsertChannelConnection(
          input.siteId,
          staged.channelId,
          {
            ...connectionPatch,
            status: regulatoryDeferred ? "in_progress" : "connected",
            metadata: {
              ...connectionPatch.metadata,
              agent_enabled: true,
              activation_pending: regulatoryDeferred,
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
            metadata: {
              ...connectionPatch.metadata,
              agent_enabled: false,
              activation_pending: true,
            },
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
      finalConnectionPersisted = true;
      const canonical = await updateAllVoiceConnectionPreferences(
        input.siteId,
        voicePreferences
      );
      persisted = {
        ...persisted,
        connections: canonical.connections,
        connection:
          canonical.connections.find(
            (connection) => connection.id === persisted.channelId
          ) || persisted.connection,
      };

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
        voiceLanguage: voicePreferences.language,
        ttsVoiceId: voicePreferences.ttsVoiceId || null,
      });
    } catch (zavuError: any) {
      if (preferencesPersisted && preferencesState) {
        try {
          await updateCustomerSupportVoicePreferences(
            input.siteId,
            preferencesState.current
          );
          await updateAllVoiceConnectionPreferences(
            input.siteId,
            preferencesState.current
          );
        } catch (rollbackError) {
          console.error("[Zavu Voice] Failed to restore Voice preferences:", rollbackError);
        }
      }
      if (finalConnectionPersisted && staged) {
        try {
          await restoreChannelConnections(input.siteId, [staged.connection]);
        } catch (rollbackError) {
          console.error("[Zavu Voice] Failed to restore staged connection:", rollbackError);
        }
      }
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
          await rollbackVoiceAgentSynchronization(synced);
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
    const body = voiceSyncRequestSchema.safeParse(await request.json());
    if (!body.success) {
      return NextResponse.json({ error: "Invalid Voice configuration" }, { status: 400 });
    }
    const updatesPreferences = hasVoicePreferencesPatch(body.data);
    if (!updatesPreferences) {
      await requireZavuSiteAccess(request, body.data.siteId);
      const synced = await syncConnectedCustomerSupportVoiceAgent(body.data.siteId);
      return NextResponse.json({
        success: true,
        synced,
      });
    }

    await requireZavuSiteManager(request, body.data.siteId);
    const channel = await getChannelConnection(
      body.data.siteId,
      body.data.channelId
    );
    if (!channel || channel.type !== "voice") {
      return NextResponse.json(
        { error: "Voice channel not found" },
        { status: 404 }
      );
    }
    const preferences = await resolveVoicePreferences(
      body.data.siteId,
      body.data
    );
    const syncResult = await syncConnectedCustomerSupportVoiceAgentDetailed(
      body.data.siteId,
      { voicePreferences: preferences.desired }
    );
    let preferencesPersisted = false;
    try {
      await updateCustomerSupportVoicePreferences(body.data.siteId, {
        language: preferences.desired.language,
        ttsVoiceId: preferences.desired.ttsVoiceId || null,
      });
      preferencesPersisted = true;
      const persisted = await updateAllVoiceConnectionPreferences(
        body.data.siteId,
        preferences.desired
      );
      return NextResponse.json({
        success: true,
        synced: syncResult.synced,
        connection: persisted.connections.find(
          (connection) => connection.id === body.data.channelId
        ),
        connections: persisted.connections,
        voiceLanguage: preferences.desired.language,
        ttsVoiceId: preferences.desired.ttsVoiceId || null,
      });
    } catch (persistenceError) {
      try {
        await rollbackConnectedVoiceAgentSync(body.data.siteId, syncResult);
      } catch (rollbackError) {
        console.error("[Zavu Voice] Failed to restore synchronized agent:", rollbackError);
      }
      if (preferencesPersisted) {
        try {
          await updateCustomerSupportVoicePreferences(
            body.data.siteId,
            preferences.current
          );
          await updateAllVoiceConnectionPreferences(
            body.data.siteId,
            preferences.current
          );
        } catch (rollbackError) {
          console.error("[Zavu Voice] Failed to restore Voice preferences:", rollbackError);
        }
      }
      throw persistenceError;
    }
  } catch (error: any) {
    console.error("[Zavu Voice] Agent sync failed:", error);
    return NextResponse.json(
      { error: error.status ? error.message : "Failed to sync Voice agent" },
      { status: error.status || 500 }
    );
  }
}
