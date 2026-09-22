import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/lib/database/supabase-server";
import { placeVoiceCall, type ZavuVoiceCall } from "./voice-call-client";
import { getVoiceCallEligibility } from "./voice-call-consent";

const E164_PHONE = /^\+[1-9]\d{6,14}$/;
const CONNECTED_STATUSES = new Set(["connected", "active", "synced"]);
const TERMINAL_CLIENT_ERROR_MIN = 400;
const TERMINAL_CLIENT_ERROR_MAX = 499;

export interface PlaceTrackedVoiceCallInput {
  siteId: string;
  to: string;
  greeting: string;
  messageId: string;
  conversationId?: string;
  leadId?: string;
  audienceId?: string;
  language?: string;
  maxDurationMinutes?: number;
}

export interface PlaceTrackedVoiceCallResult {
  deliveryId: string;
  call: ZavuVoiceCall;
  duplicate: boolean;
}

type VoiceConnection = {
  zavu_sender_id?: unknown;
  status?: unknown;
  type?: unknown;
};

function parseConnections(channels: unknown): VoiceConnection[] {
  let value = channels;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!value || typeof value !== "object") return [];
  const connections = (value as { connections?: unknown }).connections;
  return Array.isArray(connections) ? connections : [];
}

async function resolveVoiceSenderId(siteId: string): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("settings")
    .select("channels")
    .eq("site_id", siteId)
    .maybeSingle();
  if (error) throw new Error("Failed to load Voice configuration");

  const connection = parseConnections(data?.channels).find(
    (candidate) =>
      candidate.type === "voice"
      && typeof candidate.status === "string"
      && CONNECTED_STATUSES.has(candidate.status)
      && typeof candidate.zavu_sender_id === "string"
  );
  if (!connection || typeof connection.zavu_sender_id !== "string") {
    throw Object.assign(
      new Error("No connected Voice sender is configured for this site"),
      { status: 409 }
    );
  }
  return connection.zavu_sender_id;
}

async function loadMessageContext(messageId: string, siteId: string): Promise<{
  conversationId: string;
  leadId?: string;
  audienceId?: string;
}> {
  const { data, error } = await supabaseAdmin
    .from("messages")
    .select("id, conversation_id, lead_id, custom_data, conversations!inner(site_id)")
    .eq("id", messageId)
    .eq("conversations.site_id", siteId)
    .maybeSingle();
  if (error) throw new Error("Failed to validate Voice call message");
  if (!data) {
    throw Object.assign(
      new Error("Voice call message was not found for this site"),
      { status: 404 }
    );
  }
  const customData =
    data.custom_data && typeof data.custom_data === "object"
      ? data.custom_data as Record<string, unknown>
      : {};
  return {
    conversationId: data.conversation_id,
    ...(typeof data.lead_id === "string" ? { leadId: data.lead_id } : {}),
    ...(typeof customData.audience_id === "string"
      ? { audienceId: customData.audience_id }
      : {}),
  };
}

async function existingDelivery(messageId: string) {
  const { data, error } = await supabaseAdmin
    .from("voice_call_deliveries")
    .select("id, zavu_call_id, status, recipient_phone")
    .eq("message_id", messageId)
    .maybeSingle();
  if (error) throw new Error("Failed to read Voice call delivery");
  return data;
}

export async function assertVoiceCallAllowed(
  siteId: string,
  leadId: string | undefined,
  recipient: string
): Promise<void> {
  if (!leadId) {
    throw Object.assign(
      new Error("Voice calls require a lead with explicit consent"),
      { status: 403 }
    );
  }
  const { data, error } = await supabaseAdmin
    .from("leads")
    .select("phone, do_not_call, voice_call_consent_status, voice_call_consent_at")
    .eq("id", leadId)
    .eq("site_id", siteId)
    .maybeSingle();
  if (error) throw new Error("Failed to validate Voice call consent");
  if (!data) {
    throw Object.assign(new Error("Voice call lead was not found"), { status: 404 });
  }

  const normalizedPhone =
    typeof data.phone === "string" ? data.phone.replace(/[^\d+]/g, "") : "";
  if (normalizedPhone !== recipient) {
    throw Object.assign(
      new Error("Voice call recipient does not match the consented lead phone"),
      { status: 403 }
    );
  }
  const eligibility = getVoiceCallEligibility(data);
  if (!eligibility.allowed) {
    throw Object.assign(new Error(eligibility.reason), { status: 403 });
  }
}

async function markMessagePlaced(
  messageId: string,
  call: ZavuVoiceCall,
  deliveryId: string
): Promise<void> {
  const { data, error: readError } = await supabaseAdmin
    .from("messages")
    .select("custom_data")
    .eq("id", messageId)
    .maybeSingle();
  if (readError) {
    throw new Error("Failed to read Voice call message state");
  }
  const customData =
    data?.custom_data && typeof data.custom_data === "object"
      ? data.custom_data as Record<string, unknown>
      : {};
  const { error } = await supabaseAdmin
    .from("messages")
    .update({
      custom_data: {
        ...customData,
        status: "sent",
        voice_mode: "agent_call",
        voice_call_delivery_id: deliveryId,
        provider_call_id: call.id,
        call_status: call.status,
        sent_at: new Date().toISOString(),
      },
      updated_at: new Date().toISOString(),
    })
    .eq("id", messageId);
  if (error) {
    throw new Error(
      `Call ${call.id} was placed but message ${messageId} could not be updated`
    );
  }
}

function providerStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("status" in error)) return undefined;
  return typeof error.status === "number" ? error.status : undefined;
}

export async function placeTrackedVoiceCall(
  input: PlaceTrackedVoiceCallInput
): Promise<PlaceTrackedVoiceCallResult> {
  if (!E164_PHONE.test(input.to)) {
    throw Object.assign(
      new Error("Voice call recipient must use E.164 format"),
      { status: 400 }
    );
  }
  if (!input.greeting.trim() || input.greeting.length > 1_000) {
    throw Object.assign(
      new Error("Voice call greeting must contain 1 to 1000 characters"),
      { status: 400 }
    );
  }

  const messageContext = await loadMessageContext(input.messageId, input.siteId);
  const previous = await existingDelivery(input.messageId);
  if (previous?.zavu_call_id) {
    const call = {
      id: previous.zavu_call_id,
      direction: "outbound",
      from: "",
      to: previous.recipient_phone,
      status: previous.status,
      createdAt: "",
    } as ZavuVoiceCall;
    await markMessagePlaced(input.messageId, call, previous.id);
    return {
      deliveryId: previous.id,
      duplicate: true,
      call,
    };
  }
  if (previous) {
    throw Object.assign(
      new Error(
        previous.status === "placement_unknown"
          ? "Voice call placement outcome is unknown and requires reconciliation"
          : "Voice call placement is already in progress"
      ),
      { status: 409 }
    );
  }

  await assertVoiceCallAllowed(
    input.siteId,
    messageContext.leadId,
    input.to
  );
  const senderId = await resolveVoiceSenderId(input.siteId);
  const deliveryId = randomUUID();
  const attemptToken = randomUUID();
  const { error: insertError } = await supabaseAdmin
    .from("voice_call_deliveries")
    .insert({
      id: deliveryId,
      site_id: input.siteId,
      message_id: input.messageId,
      conversation_id: messageContext.conversationId,
      lead_id: messageContext.leadId || null,
      audience_id: messageContext.audienceId || null,
      zavu_sender_id: senderId,
      recipient_phone: input.to,
      status: "placing",
      placement_attempt_token: attemptToken,
    });
  if (insertError) {
    const raced = await existingDelivery(input.messageId);
    if (raced?.zavu_call_id) {
      const call = {
        id: raced.zavu_call_id,
        direction: "outbound",
        from: "",
        to: raced.recipient_phone,
        status: raced.status,
        createdAt: "",
      } as ZavuVoiceCall;
      await markMessagePlaced(input.messageId, call, raced.id);
      return {
        deliveryId: raced.id,
        duplicate: true,
        call,
      };
    }
    if (insertError.message?.includes("VOICE_CALL_CONCURRENCY_LIMIT")) {
      throw Object.assign(
        new Error("Voice call concurrency limit reached"),
        { status: 429 }
      );
    }
    throw new Error("Failed to claim Voice call delivery");
  }

  let call: ZavuVoiceCall;
  try {
    call = await placeVoiceCall({
      to: input.to,
      senderId,
      greeting: input.greeting,
      ...(input.language ? { language: input.language } : {}),
      ...(input.maxDurationMinutes
        ? { maxDurationMinutes: input.maxDurationMinutes }
        : {}),
      metadata: {
        voiceCallDeliveryId: deliveryId,
        messageId: input.messageId,
        ...(messageContext.audienceId
          ? { audienceId: messageContext.audienceId }
          : {}),
        ...(messageContext.leadId ? { leadId: messageContext.leadId } : {}),
      },
    });
  } catch (error) {
    const status = providerStatus(error);
    const terminal =
      status !== undefined
      && status >= TERMINAL_CLIENT_ERROR_MIN
      && status <= TERMINAL_CLIENT_ERROR_MAX
      && status !== 408
      && status !== 409
      && status !== 425
      && status !== 429;
    await supabaseAdmin
      .from("voice_call_deliveries")
      .update({
        status: terminal ? "failed" : "placement_unknown",
        error_message: error instanceof Error ? error.message : String(error),
        updated_at: new Date().toISOString(),
      })
      .eq("id", deliveryId)
      .eq("placement_attempt_token", attemptToken);
    throw error;
  }

  const { error: updateError } = await supabaseAdmin
    .from("voice_call_deliveries")
    .update({
      zavu_call_id: call.id,
      status: call.status,
      provider_created_at: call.createdAt || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", deliveryId)
    .eq("placement_attempt_token", attemptToken);
  if (updateError) {
    console.error(
      `[Zavu Voice] Call ${call.id} was placed but delivery ${deliveryId} could not be updated:`,
      updateError
    );
  }
  await markMessagePlaced(input.messageId, call, deliveryId);
  return { deliveryId, call, duplicate: false };
}
