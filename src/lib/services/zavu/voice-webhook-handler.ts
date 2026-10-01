import { supabaseAdmin } from "@/lib/database/supabase-server";
import { clearVoiceCallContactContext } from "./contact-client";
import { getVoiceCall } from "./voice-call-client";
import {
  handleUntrackedInboundVoiceEvent,
  type InboundDelivery,
} from "./inbound-voice-context";
import { persistVoiceTranscript } from "./voice-transcript";
import { normalizeVoiceDeliveryStatus } from "./voice-status";
import { voiceCommandStatus } from './voice-call-message-state';
import { resolveInboundVoiceLead, linkInboundVoiceLead } from './inbound-voice-lead';

function tenantDatabase() {
  return supabaseAdmin.schema(
    process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA
    || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA
    || "public"
  );
}

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
      "id, message_id, site_id, conversation_id, lead_id, zavu_sender_id, zavu_call_id, "
      + "recipient_phone, status, duration_seconds, end_reason, turn_count, "
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
  let delivery = deliveries?.[0] as unknown as InboundDelivery | undefined;
  if (delivery?.zavu_call_id && delivery.zavu_call_id !== callId) {
    throw new Error("Voice webhook does not match the persisted provider call");
  }
  const senderId = event?.senderId ?? data?.senderId ?? event?.sender?.id;
  if (delivery && senderId && senderId !== delivery.zavu_sender_id) {
    throw new Error("Voice webhook does not match the persisted sender");
  }
  let callDetails: Awaited<ReturnType<typeof getVoiceCall>> | undefined;
  let untrackedInbound = false;
  if (!delivery) {
    const inbound = await handleUntrackedInboundVoiceEvent(event, callId);
    if (!inbound.handled) {
      console.warn(`[Zavu Webhook] No local Voice delivery found for ${callId}`);
      return;
    }
    callDetails = inbound.call;
    delivery = inbound.delivery;
    if (!delivery) return;
    untrackedInbound = true;
  }
  if (
    TERMINAL_VOICE_STATUSES.has(delivery.status)
    && event.type !== "call.completed"
    && event.type !== "call.failed"
  ) return;

  if (
    !callDetails
    && event.type === "call.completed"
    && data?.transcriptAvailable === true
  ) {
    callDetails = await getVoiceCall(callId);
  }
  if (
    event.type === "call.completed"
    && data?.transcriptAvailable === true
    && !callDetails?.transcript?.length
    && !delivery.transcript?.length
  ) {
    // Do not acknowledge completion until Zavu actually exposes the turns.
    // A failed webhook claim can be retried with the same deterministic IDs.
    throw new Error(`Voice transcript is not yet available for call ${callId}`);
  }

  const status = resolveVoiceCallWebhookStatus(
    event.type,
    data?.status ?? data?.call?.status,
    callDetails?.status,
    delivery.status
  );
  const terminal = TERMINAL_VOICE_STATUSES.has(status);
  const failed = terminal && status !== "completed";
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

  const { data: message, error: messageReadError } = await tenantDatabase()
    .from("messages")
    .select("custom_data")
    .eq("id", delivery.message_id)
    .maybeSingle();
  if (messageReadError) {
    throw new Error(`Failed to read Voice call message: ${messageReadError.message}`);
  }
  const customData =
    message?.custom_data && typeof message.custom_data === "object"
      ? message.custom_data as Record<string, unknown>
      : {};
  const inbound = customData.call_direction === "inbound";
  if (inbound && terminal && !untrackedInbound && delivery.site_id && delivery.conversation_id) {
    // Reconcile legacy/unlinked calls when a later terminal webhook arrives.
    // Do not trust a lead ID or contact details embedded in transcript/tool text.
    const leadId = delivery.lead_id || await resolveInboundVoiceLead(delivery.site_id, delivery.recipient_phone);
    await linkInboundVoiceLead({ siteId: delivery.site_id, conversationId: delivery.conversation_id,
      deliveryId: delivery.id, callId, leadId });
    delivery = { ...delivery, lead_id: leadId };
  }
  const {
    voice_response_workflow_status: _oldStatus,
    voice_response_workflow_id: _oldWorkflowId,
    ...retainedCustomData
  } = customData;
  let agentId: string | undefined;
  if (inbound && terminal && callDetails?.agentId && delivery.site_id) {
    const { data: agent, error: agentError } = await supabaseAdmin
      .from("agents")
      .select("id")
      .eq("site_id", delivery.site_id)
      .eq("configuration->zavu->>agent_id", callDetails.agentId)
      .limit(1)
      .maybeSingle();
    if (agentError) throw new Error(`Failed to resolve Voice agent: ${agentError.message}`);
    agentId = agent?.id;
    if (agentId && delivery.conversation_id) {
      const { error: conversationError } = await tenantDatabase()
        .from("conversations")
        .update({ agent_id: agentId })
        .eq("site_id", delivery.site_id)
        .eq("id", delivery.conversation_id)
        .is("agent_id", null);
      if (conversationError) {
        throw new Error(`Failed to link inbound Voice agent: ${conversationError.message}`);
      }
    }
  }
  const messageCustomData: Record<string, unknown> = {
    ...(inbound ? retainedCustomData : customData),
    status: failed
      ? "failed"
      : terminal
        ? (inbound ? "received" : "sent")
        : "sending",
    voice_mode: "agent_call",
    voice_call_delivery_id: delivery.id,
    provider_call_id: callId,
    call_status: status,
  };
  messageCustomData.command_status = voiceCommandStatus(messageCustomData.status);
  if (durationSeconds != null) messageCustomData.duration_seconds = durationSeconds;
  if (endReason != null) messageCustomData.end_reason = endReason;
  if (data?.transcriptAvailable === true || (transcript?.length ?? 0) > 0) {
    messageCustomData.transcript_available = true;
  }
  if (failed) {
    messageCustomData.error_message = endReason || `Voice call ${status}`;
  }
  const { error: messageError } = await tenantDatabase()
    .from("messages")
    .update({
      custom_data: messageCustomData,
      updated_at: now,
    })
    .eq("id", delivery.message_id);
  if (messageError) {
    throw new Error(`Failed to update Voice call message: ${messageError.message}`);
  }

  // For existing inbound and outbound deliveries, keep the raw provider
  // transcript on the delivery and materialize only spoken turns in chat.
  if (terminal && !untrackedInbound && delivery.conversation_id && delivery.site_id) {
    const existingTranscript = Array.isArray(delivery.transcript) ? delivery.transcript : [];
    const turns = callDetails?.transcript?.length ? callDetails.transcript : existingTranscript;
    if (turns.length > 0) {
      await persistVoiceTranscript({
        call: {
          id: callId,
          direction: inbound ? "inbound" : "outbound",
          transcript: turns,
          endedAt: callDetails?.endedAt || delivery.ended_at,
          createdAt: callDetails?.createdAt || delivery.answered_at,
        },
        siteId: delivery.site_id,
        conversationId: delivery.conversation_id,
        deliveryId: delivery.id,
        leadId: delivery.lead_id,
        agentId,
      });
    }
  }

  // Remove the abandoned Customer Support workflow marker only after the
  // transcript has been materialized successfully for this inbound call.
  if (inbound && terminal && delivery.conversation_id && delivery.site_id) {
    const { data: conversation, error: conversationReadError } = await tenantDatabase()
      .from("conversations")
      .select("custom_data")
      .eq("id", delivery.conversation_id)
      .eq("site_id", delivery.site_id)
      .maybeSingle();
    if (conversationReadError) {
      throw new Error(`Failed to read inbound Voice conversation: ${conversationReadError.message}`);
    }
    const conversationData = conversation?.custom_data;
    if (conversationData?.voice_response_workflow_status) {
      const {
        voice_response_workflow_status: _oldStatus,
        voice_response_workflow_id: _oldWorkflowId,
        ...retainedConversationData
      } = conversationData as Record<string, unknown>;
      const { error: conversationUpdateError } = await tenantDatabase()
        .from("conversations")
        .update({ custom_data: retainedConversationData })
        .eq("id", delivery.conversation_id)
        .eq("site_id", delivery.site_id);
      if (conversationUpdateError) {
        throw new Error(`Failed to update inbound Voice conversation: ${conversationUpdateError.message}`);
      }
    }
  }
  // Contact metadata is optional guidance, not part of the durable call result.
  // Inbound calls use the provider call ID as the metadata owner; outbound
  // calls use the delivery ID. Never fail a completed webhook on cleanup.
  if (terminal && !untrackedInbound) {
    try {
      await clearVoiceCallContactContext({
        phone: delivery.recipient_phone,
        deliveryId: inbound ? callId : delivery.id,
      });
    } catch (error) {
      console.warn(`[Zavu Webhook] Contact context cleanup failed for ${callId}:`, error);
    }
  }
}
