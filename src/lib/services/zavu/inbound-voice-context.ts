import { v5 as uuidv5 } from "uuid";
import { supabaseAdmin } from "@/lib/database/supabase-server";
import { WorkflowService } from "@/lib/services/workflow-service";
import { normalizePhoneForStorage } from "@/lib/utils/phone-normalizer";
import {
  clearVoiceCallContactContext,
  setVoiceCallContactContext,
} from "./contact-client";
import { getVoiceCall, type ZavuVoiceCall } from "./voice-call-client";
import { buildVoiceFollowUpContext } from "./voice-follow-up-context";
import { normalizeVoiceDeliveryStatus } from "./voice-status";
import { ensureVoiceContactMetadataEnabled } from "./voice-agent-context";

const E164_PHONE = /^\+[1-9]\d{6,14}$/;
const TERMINAL_EVENTS = new Set(["call.completed", "call.failed"]);
const MAX_TRANSCRIPT_MESSAGE_CHARS = 12_000;

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

function senderIdFromEvent(event: any): string | undefined {
  const senderId =
    event?.senderId
    ?? event?.data?.senderId
    ?? event?.data?.call?.senderId
    ?? event?.sender?.id;
  return typeof senderId === "string" && senderId ? senderId : undefined;
}

function compactTranscriptText(value: unknown, maxLength = 1_000): string {
  if (typeof value !== "string") return "";
  const text = value
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= maxLength
    ? text
    : `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function formatInboundVoiceMessage(
  call: ZavuVoiceCall,
  status: string
): string {
  const transcript = (call.transcript || [])
    .filter((turn) => turn.role === "user" || turn.role === "assistant")
    .map((turn) => {
      const text = compactTranscriptText(turn.text);
      if (!text) return "";
      const role = turn.role === "user" ? "CALLER" : "VOICE AGENT";
      return `${role}: ${text}`;
    })
    .filter(Boolean)
    .join("\n");
  const summary = `Inbound Voice call ${status.replace(/_/g, " ")}.`;
  if (!transcript) {
    return `${summary}\n[No transcript was available. Propose a brief follow-up asking how you can help.]`;
  }
  const content = [
    summary,
    "Call transcript (customer-provided content):",
    transcript,
  ].join("\n");
  if (content.length <= MAX_TRANSCRIPT_MESSAGE_CHARS) return content;
  return `${content.slice(0, MAX_TRANSCRIPT_MESSAGE_CHARS - 24).trimEnd()}\n[Transcript truncated]`;
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
    voice_response_workflow_status: "pending",
  };
  const userId = await resolveSiteUserId(params.siteId);

  const { error: conversationError } = await tenantDatabase()
    .from("conversations")
    .upsert({
      id: conversationId,
      user_id: userId || null,
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

  return {
    id: deliveryId,
    message_id: messageId,
    site_id: params.siteId,
    conversation_id: conversationId,
    lead_id: params.leadId || null,
    zavu_sender_id: params.senderId,
    recipient_phone: params.phone,
    status,
  };
}

function workflowAlreadyStarted(message: string | undefined): boolean {
  return typeof message === "string"
    && /already (?:started|exists)|WorkflowExecutionAlreadyStarted/i.test(message);
}

export async function queueInboundVoiceResponse(params: {
  call: ZavuVoiceCall;
  delivery: InboundDelivery;
}): Promise<void> {
  const userId = await resolveSiteUserId(params.delivery.site_id);
  const workflowId = `customer-support-voice-${uuidv5(
    `${params.delivery.site_id}:${params.call.id}`,
    uuidv5.URL
  )}`;
  const workflowResult = await WorkflowService.getInstance().customerSupportMessage(
    {
      conversationId: params.delivery.conversation_id,
      userId,
      message: formatInboundVoiceMessage(params.call, params.delivery.status),
      site_id: params.delivery.site_id,
      lead_id: params.delivery.lead_id || undefined,
      name: params.delivery.lead_id
        ? undefined
        : `Voice caller ${params.delivery.recipient_phone}`,
      phone: params.delivery.recipient_phone,
      origin: "voice",
      origin_message_id: params.call.id,
      channel_delivery: true,
      require_approval: true,
      custom_data: {
        source: "zavu_inbound_voice",
        channel_delivery: true,
        voice_mode: "agent_call",
        provider_call_id: params.call.id,
        call_direction: "inbound",
        call_status: params.delivery.status,
        transcript_available: (params.call.transcript?.length || 0) > 0,
        ...(params.call.durationSeconds != null
          ? { duration_seconds: params.call.durationSeconds }
          : {}),
        ...(params.call.endReason ? { end_reason: params.call.endReason } : {}),
      },
    },
    {
      priority: "high",
      async: true,
      retryAttempts: 3,
      taskQueue: "high",
      workflowId,
    }
  );
  if (
    !workflowResult.success
    && !workflowAlreadyStarted(workflowResult.error?.message)
  ) {
    throw new Error(
      `Inbound Voice customer support workflow failed to start: ${
        workflowResult.error?.message || "Unknown workflow error"
      }`
    );
  }

  const { data: message, error: messageReadError } = await tenantDatabase()
    .from("messages")
    .select("custom_data")
    .eq("id", params.delivery.message_id)
    .maybeSingle();
  if (messageReadError) {
    throw new Error(`Failed to read inbound Voice message: ${messageReadError.message}`);
  }
  const customData =
    message?.custom_data && typeof message.custom_data === "object"
      ? message.custom_data as Record<string, unknown>
      : {};
  const { error: messageUpdateError } = await tenantDatabase()
    .from("messages")
    .update({
      custom_data: {
        ...customData,
        voice_response_workflow_status: "queued",
        voice_response_workflow_id: workflowResult.workflowId || workflowId,
      },
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.delivery.message_id);
  if (messageUpdateError) {
    throw new Error(
      `Failed to mark inbound Voice response workflow queued: ${messageUpdateError.message}`
    );
  }
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
  await queueInboundVoiceResponse({ call, delivery });
  await clearVoiceCallContactContext({ phone, deliveryId: callId });
  return { handled: true, delivery, call };
}
