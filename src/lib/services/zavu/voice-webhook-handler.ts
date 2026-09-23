import { supabaseAdmin } from "@/lib/database/supabase-server";
import { clearVoiceCallContactContext } from "./contact-client";
import { getVoiceCall } from "./voice-call-client";
import { handleUntrackedInboundVoiceEvent } from "./inbound-voice-context";
import { normalizeVoiceDeliveryStatus } from "./voice-status";

function voiceEventMetadata(data: any): Record<string, string> {
  const rawMetadata = data?.metadata ?? data?.call?.metadata;
  if (!rawMetadata || typeof rawMetadata !== "object") return {};
  return Object.fromEntries(
    Object.entries(rawMetadata)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

const TERMINAL_VOICE_STATUSES = new Set([
  "completed",
  "failed",
  "busy",
  "no_answer",
  "canceled",
  "cancelled",
]);
export function resolveVoiceCallWebhookStatus(
  eventType: string,
  reportedStatus: unknown,
  fetchedStatus: unknown,
  currentStatus: string
): string {
  if (TERMINAL_VOICE_STATUSES.has(currentStatus)) {
    return normalizeVoiceDeliveryStatus(currentStatus);
  }
  if (eventType === "call.completed") return "completed";
  if (eventType === "call.failed") {
    return typeof reportedStatus === "string"
      && TERMINAL_VOICE_STATUSES.has(reportedStatus)
      ? normalizeVoiceDeliveryStatus(reportedStatus, "failed")
      : "failed";
  }
  const candidate =
    typeof reportedStatus === "string" ? reportedStatus : fetchedStatus;
  return normalizeVoiceDeliveryStatus(candidate);
}

export async function handleVoiceCallEvent(event: any): Promise<void> {
  const data = event?.data;
  const callId = [data?.callId, data?.call_id, data?.id, data?.call?.id]
    .find((value): value is string => typeof value === "string");
  if (!callId) {
    throw new Error("Voice call webhook is missing data.callId");
  }

  const metadata = voiceEventMetadata(data);
  let query = supabaseAdmin
    .from("voice_call_deliveries")
    .select(
      "id, message_id, recipient_phone, status, duration_seconds, end_reason, turn_count, "
      + "cost, currency, transcript, answered_at, ended_at"
    )
    .limit(1);
  query = metadata.voiceCallDeliveryId
    ? query.eq("id", metadata.voiceCallDeliveryId)
    : query.eq("zavu_call_id", callId);
  const { data: deliveries, error: deliveryError } = await query;
  if (deliveryError) {
    throw new Error(`Failed to find Voice call delivery: ${deliveryError.message}`);
  }
  let delivery = deliveries?.[0] as unknown as {
    id: string;
    message_id: string;
    recipient_phone: string;
    status: string;
  } | undefined;
  let callDetails: Awaited<ReturnType<typeof getVoiceCall>> | undefined;
  if (!delivery) {
    const inbound = await handleUntrackedInboundVoiceEvent(event, callId);
    if (!inbound.handled) {
      console.warn(`[Zavu Webhook] No local Voice delivery found for ${callId}`);
      return;
    }
    callDetails = inbound.call;
    delivery = inbound.delivery;
    if (!delivery) return;
  }
  if (
    TERMINAL_VOICE_STATUSES.has(delivery.status)
    && event.type !== "call.completed"
    && event.type !== "call.failed"
  ) {
    await clearVoiceCallContactContext({
      phone: delivery.recipient_phone,
      deliveryId: delivery.id,
    });
    return;
  }

  if (
    !callDetails
    && event.type === "call.completed"
    && data?.transcriptAvailable === true
  ) {
    callDetails = await getVoiceCall(callId);
  }

  const status = resolveVoiceCallWebhookStatus(
    event.type,
    data?.status ?? data?.call?.status,
    callDetails?.status,
    delivery.status
  );
  const terminal = TERMINAL_VOICE_STATUSES.has(status);
  const failed = terminal && status !== "completed";
  if (terminal) {
    await clearVoiceCallContactContext({
      phone: delivery.recipient_phone,
      deliveryId: delivery.id,
    });
  }
  const now = new Date().toISOString();
  const deliveryUpdate: Record<string, unknown> = {
    zavu_call_id: callId,
    status,
    updated_at: now,
  };
  const durationSeconds = data?.durationSeconds ?? callDetails?.durationSeconds;
  const endReason = data?.endReason ?? callDetails?.endReason;
  const turnCount = callDetails?.turnCount;
  const cost = data?.cost ?? callDetails?.cost;
  const currency = data?.currency;
  const transcript = callDetails?.transcript;
  const answeredAt =
    callDetails?.answeredAt ?? (event.type === "call.answered" ? now : undefined);
  const endedAt = callDetails?.endedAt ?? (terminal ? now : undefined);
  if (durationSeconds != null) deliveryUpdate.duration_seconds = durationSeconds;
  if (endReason != null) deliveryUpdate.end_reason = endReason;
  if (turnCount != null) deliveryUpdate.turn_count = turnCount;
  if (cost != null) deliveryUpdate.cost = cost;
  if (typeof currency === "string") deliveryUpdate.currency = currency;
  if (transcript != null) deliveryUpdate.transcript = transcript;
  if (answeredAt != null) deliveryUpdate.answered_at = answeredAt;
  if (endedAt != null) deliveryUpdate.ended_at = endedAt;
  let deliveryUpdateQuery = supabaseAdmin
    .from("voice_call_deliveries")
    .update(deliveryUpdate)
    .eq("id", delivery.id);
  if (!terminal) {
    deliveryUpdateQuery = deliveryUpdateQuery.not(
      "status",
      "in",
      "(completed,failed,busy,no_answer,canceled,cancelled)"
    );
  } else if (failed) {
    deliveryUpdateQuery = deliveryUpdateQuery.neq("status", "completed");
  }
  const { data: updatedDelivery, error: updateError } = await deliveryUpdateQuery
    .select("status")
    .maybeSingle();
  if (updateError) {
    throw new Error(`Failed to update Voice call delivery: ${updateError.message}`);
  }
  if (!updatedDelivery) return;

  const { data: message } = await supabaseAdmin
    .from("messages")
    .select("custom_data")
    .eq("id", delivery.message_id)
    .maybeSingle();
  const customData =
    message?.custom_data && typeof message.custom_data === "object"
      ? message.custom_data as Record<string, unknown>
      : {};
  const messageCustomData: Record<string, unknown> = {
    ...customData,
    status: failed ? "failed" : terminal ? "sent" : "sending",
    voice_mode: "agent_call",
    voice_call_delivery_id: delivery.id,
    provider_call_id: callId,
    call_status: status,
  };
  if (durationSeconds != null) messageCustomData.duration_seconds = durationSeconds;
  if (endReason != null) messageCustomData.end_reason = endReason;
  if (data?.transcriptAvailable === true || (transcript?.length ?? 0) > 0) {
    messageCustomData.transcript_available = true;
  }
  if (failed) {
    messageCustomData.error_message = endReason || `Voice call ${status}`;
  }
  const { error: messageError } = await supabaseAdmin
    .from("messages")
    .update({
      custom_data: messageCustomData,
      updated_at: now,
    })
    .eq("id", delivery.message_id);
  if (messageError) {
    throw new Error(`Failed to update Voice call message: ${messageError.message}`);
  }
}
