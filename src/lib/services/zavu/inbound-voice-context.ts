import { v5 as uuidv5 } from "uuid";
import { supabaseAdmin } from "@/lib/database/supabase-server";
import { normalizePhoneForStorage } from "@/lib/utils/phone-normalizer";
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
const TERMINAL_EVENTS = new Set(["call.completed", "call.failed"]);

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
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to resolve inbound Voice site: ${error.message}`);
  return typeof data?.site_id === "string" ? data.site_id : undefined;
}

async function resolveLeadId(
  siteId: string,
  phone: string
): Promise<string | undefined> {
  const { data, error } = await supabaseAdmin
    .from("leads")
    .select("id")
    .eq("site_id", siteId)
    .eq("phone", phone)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to resolve inbound Voice lead: ${error.message}`);
  return typeof data?.id === "string" ? data.id : undefined;
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
  const senderId =
    event?.senderId
    ?? event?.data?.senderId
    ?? event?.data?.call?.senderId
    ?? event?.sender?.id;
  return typeof senderId === "string" && senderId ? senderId : undefined;
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
        transcript_available: (params.call.transcript?.length || 0) > 0,
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
      transcript: params.call.transcript ?? null,
      provider_created_at: params.call.createdAt || null,
      answered_at: params.call.answeredAt ?? null,
      ended_at: params.call.endedAt ?? null,
    }, { onConflict: "id", ignoreDuplicates: true });
  if (deliveryError) {
    throw new Error(`Failed to persist inbound Voice delivery: ${deliveryError.message}`);
  }

  await persistVoiceTranscript({
    call: params.call,
    siteId: params.siteId,
    conversationId,
    deliveryId,
    leadId: params.leadId,
    agentId,
  });

  return {
    id: deliveryId,
    message_id: messageId,
    site_id: params.siteId,
    conversation_id: conversationId,
    lead_id: params.leadId || null,
    zavu_sender_id: params.senderId,
    recipient_phone: params.phone,
    status,
    transcript: params.call.transcript,
  };
}

export async function handleUntrackedInboundVoiceEvent(
  event: any,
  callId: string
): Promise<InboundVoiceEventResult> {
  const call = await getVoiceCall(callId);
  if (call.direction !== "inbound") return { handled: false, call };

  const senderId = senderIdFromEvent(event);
  if (!senderId) {
    throw new Error("Inbound Voice webhook is missing senderId");
  }
  const phone = normalizePhoneForStorage(call.from);
  if (!E164_PHONE.test(phone)) {
    throw new Error("Inbound Voice caller phone is not valid E.164");
  }
  const siteId = await resolveSiteId(senderId);
  if (!siteId) {
    throw new Error(`No site is configured for inbound Voice sender ${senderId}`);
  }
  const leadId = await resolveLeadId(siteId, phone);

  if (!TERMINAL_EVENTS.has(event.type)) {
    await ensureVoiceContactMetadataEnabled(senderId);
    const followUp = await buildVoiceFollowUpContext({
      siteId,
      leadId,
      phone,
    });
    await setVoiceCallContactContext({
      phone,
      deliveryId: callId,
      siteId,
      followUpContext: followUp.context,
    });
    return { handled: true, call };
  }

  const delivery = await persistInboundCall({
    call,
    siteId,
    senderId,
    phone,
    leadId,
    eventType: event.type,
  });
  await clearVoiceCallContactContext({ phone, deliveryId: callId });
  return { handled: true, delivery, call };
}
