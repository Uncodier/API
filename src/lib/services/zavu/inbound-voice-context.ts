import { v5 as uuidv5 } from "uuid";
import { supabaseAdmin } from "@/lib/database/supabase-server";
import { normalizeVoiceIdentityPhone } from "./voice-lead-identification";
import { InboundVoiceLeadAmbiguityError, resolveInboundVoiceLead, linkInboundVoiceLead } from "./inbound-voice-lead";
import {
  clearVoiceCallContactContext,
  setVoiceCallContactContext,
} from "./contact-client";
import { getVoiceCall, type ZavuVoiceCall } from "./voice-call-client";
import { buildVoiceFollowUpContext } from "./voice-follow-up-context";
import { normalizeVoiceDeliveryStatus } from "./voice-status";
import { ensureVoiceContactMetadataEnabled } from "./voice-agent-context";
import { persistVoiceTranscript } from "./voice-transcript";

const E164_PHONE = /^\+[1-9]\d{6,14}$/;
const TERMINAL_STATUSES = new Set(["completed", "failed", "busy", "no_answer", "canceled"]);

function tenantDatabase() {
  return supabaseAdmin.schema(
    process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA
    || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA
    || "public"
  );
}

export type InboundDelivery = {
  id: string;
  message_id: string;
  site_id: string;
  conversation_id: string;
  lead_id?: string | null;
  zavu_sender_id: string;
  zavu_call_id?: string | null;
  recipient_phone: string;
  status: string;
  transcript?: ZavuVoiceCall["transcript"] | null;
  answered_at?: string | null;
  ended_at?: string | null;
};

export type InboundVoiceEventResult = {
  handled: boolean;
  delivery?: InboundDelivery;
  call?: ZavuVoiceCall;
};

async function resolveSiteId(senderId: string): Promise<string | undefined> {
  const { data, error } = await supabaseAdmin
    .from("settings")
    .select("site_id")
    .contains("channels", {
      connections: [{ zavu_sender_id: senderId }],
    })
    .limit(2)
    .maybeSingle();
  if (error) throw new Error(`Failed to resolve inbound Voice site: ${error.message}`);
  return typeof data?.site_id === "string" ? data.site_id : undefined;
}

async function resolveSiteUserId(siteId: string): Promise<string | undefined> {
  const { data, error } = await supabaseAdmin
    .from("sites")
    .select("user_id")
    .eq("id", siteId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to resolve inbound Voice site owner: ${error.message}`);
  }
  return typeof data?.user_id === "string" ? data.user_id : undefined;
}

async function resolveLocalVoiceAgentId(
  siteId: string,
  providerAgentId: string | undefined
): Promise<string | undefined> {
  if (!providerAgentId) return undefined;
  const { data, error } = await supabaseAdmin
    .from("agents")
    .select("id")
    .eq("site_id", siteId)
    .eq("configuration->zavu->>agent_id", providerAgentId)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to resolve Voice agent: ${error.message}`);
  return typeof data?.id === "string" ? data.id : undefined;
}

function senderIdFromEvent(event: any): string | undefined {
  const senderIds = [event?.senderId, event?.data?.senderId, event?.data?.call?.senderId, event?.sender?.id]
    .filter(value => value != null);
  if (senderIds.some(value => typeof value !== "string" || !value || value !== senderIds[0])) {
    throw new Error("Inbound Voice webhook has conflicting sender IDs");
  }
  return senderIds[0];
}

function resolveInboundStatus(call: ZavuVoiceCall, eventType: string): string {
  const reportedStatus = normalizeVoiceDeliveryStatus(call.status);
  if (eventType === "call.completed") return "completed";
  if (eventType === "call.failed") {
    return ["busy", "no_answer", "canceled"].includes(reportedStatus)
      ? reportedStatus
      : "failed";
  }
  return reportedStatus;
}

async function persistInboundCall(params: {
  call: ZavuVoiceCall;
  siteId: string;
  senderId: string;
  phone: string;
  leadId?: string;
  eventType: string;
}): Promise<InboundDelivery> {
  const identity = `${params.siteId}:${params.call.id}`;
  const conversationId = uuidv5(`inbound-voice-conversation:${identity}`, uuidv5.URL);
  const messageId = uuidv5(`inbound-voice-message:${identity}`, uuidv5.URL);
  const deliveryId = uuidv5(`inbound-voice-delivery:${identity}`, uuidv5.URL);
  const attemptToken = uuidv5(`inbound-voice-attempt:${identity}`, uuidv5.URL);
  const status = resolveInboundStatus(params.call, params.eventType);
  const transcript = TERMINAL_STATUSES.has(status) ? params.call.transcript : undefined;
  const sourceData = {
    source: "zavu_inbound_voice",
    channel_delivery: true,
    voice_mode: "agent_call",
    provider_call_id: params.call.id,
    call_direction: "inbound",
    call_status: status,
  };
  const userId = await resolveSiteUserId(params.siteId);
  const agentId = await resolveLocalVoiceAgentId(params.siteId, params.call.agentId);

  const { error: conversationError } = await tenantDatabase()
    .from("conversations")
    .upsert({
      id: conversationId,
      user_id: userId || null,
      agent_id: agentId || null,
      site_id: params.siteId,
      lead_id: params.leadId || null,
      channel: "voice",
      title: `Inbound Voice call from ${params.phone}`.slice(0, 255),
      custom_data: sourceData,
      updated_at:
        params.call.updatedAt
        || params.call.endedAt
        || new Date().toISOString(),
    }, { onConflict: "id", ignoreDuplicates: true });
  if (conversationError) {
    throw new Error(`Failed to persist inbound Voice conversation: ${conversationError.message}`);
  }

  const { error: messageError } = await tenantDatabase()
    .from("messages")
    .upsert({
      id: messageId,
      conversation_id: conversationId,
      lead_id: params.leadId || null,
      role: "system",
      content: `Inbound Voice call ${status.replace(/_/g, " ")}.`,
      custom_data: {
        ...sourceData,
        transcript_available: (transcript?.length || 0) > 0,
        ...(params.call.durationSeconds != null
          ? { duration_seconds: params.call.durationSeconds }
          : {}),
        ...(params.call.endReason ? { end_reason: params.call.endReason } : {}),
        voice_call_delivery_id: deliveryId,
      },
    }, { onConflict: "id", ignoreDuplicates: true });
  if (messageError) {
    throw new Error(`Failed to persist inbound Voice message: ${messageError.message}`);
  }

  const { error: deliveryError } = await supabaseAdmin
    .from("voice_call_deliveries")
    .upsert({
      id: deliveryId,
      site_id: params.siteId,
      message_id: messageId,
      conversation_id: conversationId,
      lead_id: params.leadId || null,
      zavu_sender_id: params.senderId,
      zavu_call_id: params.call.id,
      recipient_phone: params.phone,
      status,
      placement_attempt_token: attemptToken,
      duration_seconds: params.call.durationSeconds ?? null,
      end_reason: params.call.endReason ?? null,
      turn_count: params.call.turnCount ?? null,
      cost: params.call.cost ?? null,
      transcript: transcript ?? null,
      provider_created_at: params.call.createdAt || null,
      answered_at: params.call.answeredAt ?? null,
      ended_at: params.call.endedAt ?? null,
    }, { onConflict: "id", ignoreDuplicates: true });
  if (deliveryError) {
    throw new Error(`Failed to persist inbound Voice delivery: ${deliveryError.message}`);
  }

  if (params.leadId) {
    await linkInboundVoiceLead({ siteId: params.siteId, conversationId, deliveryId, callId: params.call.id, leadId: params.leadId });
  }

  // Live provider turns can still be partial. Materialize immutable transcript
  // messages only at termination, not while creating the early call context.
  if (TERMINAL_STATUSES.has(status)) {
    await persistVoiceTranscript({
      call: params.call,
      siteId: params.siteId,
      conversationId,
      deliveryId,
      leadId: params.leadId,
      agentId,
    });
  }

  return {
    id: deliveryId,
    message_id: messageId,
    site_id: params.siteId,
    conversation_id: conversationId,
    lead_id: params.leadId || null,
    zavu_sender_id: params.senderId,
    zavu_call_id: params.call.id,
    recipient_phone: params.phone,
    status,
    transcript,
    answered_at: params.call.answeredAt,
    ended_at: params.call.endedAt,
  };
}

export async function handleUntrackedInboundVoiceEvent(
  event: any,
  callId: string
): Promise<InboundVoiceEventResult> {
  const call = await getVoiceCall(callId);
  if (call.id !== callId) throw new Error("Inbound Voice provider call does not match the webhook");
  if (call.direction !== "inbound") return { handled: false, call };

  const senderId = senderIdFromEvent(event);
  if (!senderId) {
    throw new Error("Inbound Voice webhook is missing senderId");
  }
  const providerSenderId = (call as ZavuVoiceCall & { senderId?: unknown }).senderId;
  if (providerSenderId != null && providerSenderId !== senderId) {
    throw new Error("Inbound Voice provider call does not match the webhook sender");
  }
  const phone = normalizeVoiceIdentityPhone(call.from);
  if (!phone || !E164_PHONE.test(phone)) {
    throw new Error("Inbound Voice caller phone is not valid E.164");
  }
  const siteId = await resolveSiteId(senderId);
  if (!siteId) {
    throw new Error(`No site is configured for inbound Voice sender ${senderId}`);
  }
  // The webhook is already authenticated. Persist a phone-only, unverified
  // contact and call context now so live tools do not depend on IDENTIFY_LEAD.
  let leadId: string | undefined;
  try {
    leadId = await resolveInboundVoiceLead(siteId, phone);
  } catch (error) {
    if (!(error instanceof InboundVoiceLeadAmbiguityError)) throw error;
    // Preserve the call for human assistance without choosing or creating a profile.
  }
  const delivery = await persistInboundCall({
    call,
    siteId,
    senderId,
    phone,
    leadId,
    eventType: event.type,
  });

  if (!TERMINAL_STATUSES.has(delivery.status)) {
    // The live agent already owns the call. Guidance is useful, but a missing
    // contact or a provider metadata outage must not reject its webhook.
    try {
      await ensureVoiceContactMetadataEnabled(senderId);
      // A phone-only lookup could pick one of the ambiguous profiles again.
      const followUpContext = leadId
        ? (await buildVoiceFollowUpContext({ siteId, leadId, phone })).context
        : "Caller identity is ambiguous. Do not use or disclose CRM profiles. Request human assistance.";
      await setVoiceCallContactContext({
        phone,
        deliveryId: callId,
        siteId,
        followUpContext,
      });
    } catch (error) {
      console.warn(`[Zavu Webhook] Voice contact guidance unavailable for ${callId}:`, error);
    }
    return { handled: true, delivery, call };
  }

  try {
    await clearVoiceCallContactContext({ phone, deliveryId: callId });
  } catch (error) {
    console.warn(`[Zavu Webhook] Contact context cleanup failed for ${callId}:`, error);
  }
  return { handled: true, delivery, call };
}
