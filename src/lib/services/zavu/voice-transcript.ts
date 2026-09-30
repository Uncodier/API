import { v5 as uuidv5 } from "uuid";
import { supabaseAdmin } from "@/lib/database/supabase-server";
import type { ZavuVoiceCallTurn } from "./voice-call-client";

type TranscriptCall = {
  id: string;
  direction: "inbound" | "outbound";
  transcript?: ZavuVoiceCallTurn[] | null;
  createdAt?: string | null;
  endedAt?: string | null;
};

function tenantDatabase() {
  return supabaseAdmin.schema(
    process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA
    || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA
    || "public"
  );
}

function compactSpeech(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim();
  return text;
}

const MAX_TOOL_TEXT_LENGTH = 64 * 1024;

function safeToolFailure(value: unknown) {
  // Provider text is untrusted. Accept JSON or one JSON-encoded string only,
  // with bounded work; never evaluate it or extract errors from arbitrary text.
  if (typeof value !== "string") return null;
  let parsed: unknown = value;
  try {
    for (let attempt = 0; attempt < 2 && typeof parsed === "string"; attempt++) {
      if (parsed.length > MAX_TOOL_TEXT_LENGTH) return null;
      parsed = JSON.parse(parsed);
    }
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const httpStatus = (parsed as Record<string, unknown>).http_status;
  if (
    typeof httpStatus !== "number"
    || !Number.isInteger(httpStatus)
    || httpStatus < 400
    || httpStatus > 599
  ) return null;

  const authFailed = httpStatus === 401 || httpStatus === 403;
  const body = (parsed as Record<string, unknown>).http_body;
  const candidateRequestId = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>).request_id : undefined;
  const requestId = typeof candidateRequestId === "string"
    && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(candidateRequestId)
    ? candidateRequestId : undefined;
  // Only validated status and our UUID correlation ID may cross into chat.
  return {
    httpStatus,
    requestId,
    code: authFailed ? "VOICE_TOOL_AUTH_FAILED" : "VOICE_TOOL_FAILED",
    content: authFailed
      ? `Voice tool callback authentication failed (HTTP ${httpStatus}).`
      : `Voice tool request failed (HTTP ${httpStatus}).`,
  };
}

/** Materialize speech and safe tool failures; retain the full call on the delivery. */
export async function persistVoiceTranscript(params: {
  call: TranscriptCall;
  siteId: string;
  conversationId: string;
  deliveryId: string;
  leadId?: string | null;
  agentId?: string;
}): Promise<void> {
  const turns = Array.isArray(params.call.transcript) ? params.call.transcript : [];
  const baseTime = Date.parse(params.call.createdAt || params.call.endedAt || "");
  const fallbackTime = Number.isFinite(baseTime) ? baseTime : Date.now();
  let lastTimestamp = fallbackTime - 1;
  const messages = turns.flatMap((turn, index) => {
    if (turn?.role !== "user" && turn?.role !== "assistant" && turn?.role !== "tool") return [];
    const toolFailure = turn.role === "tool" ? safeToolFailure(turn.text) : null;
    const content = turn.role === "tool" ? toolFailure?.content : compactSpeech(turn.text);
    if (!content) return [];
    const seq = toolFailure && (!Number.isSafeInteger(turn.seq) || turn.seq < 0)
      ? index
      : turn.seq;
    const providerTime = Date.parse(turn.startedAt || "");
    lastTimestamp = Math.max(
      Number.isFinite(providerTime) ? providerTime : fallbackTime + index,
      lastTimestamp + 1
    );
    return [{
      id: uuidv5(
        `voice-turn:${params.siteId}:${params.call.id}:${index}`,
        uuidv5.URL
      ),
      conversation_id: params.conversationId,
      lead_id: params.leadId || null,
      ...(turn.role === "assistant" && params.agentId
        ? { agent_id: params.agentId }
        : {}),
      role: toolFailure ? "system" : turn.role,
      content,
      created_at: new Date(lastTimestamp).toISOString(),
      custom_data: {
        source: toolFailure ? "zavu_voice_tool_error" : "zavu_voice_transcript",
        channel_delivery: true,
        voice_mode: "agent_call",
        call_direction: params.call.direction,
        provider_call_id: params.call.id,
        voice_call_delivery_id: params.deliveryId,
        transcript_seq: seq,
        status: toolFailure ? "failed" : turn.role === "user" ? "received" : "sent",
        ...(toolFailure ? {
          code: toolFailure.code,
          http_status: toolFailure.httpStatus,
          ...(toolFailure.requestId ? { request_id: toolFailure.requestId } : {}),
          call_id: params.call.id,
          seq,
        } : {}),
      },
    }];
  });
  if (messages.length === 0) return;

  const { error } = await tenantDatabase()
    .from("messages")
    .upsert(messages, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw new Error(`Failed to persist Voice transcript: ${error.message}`);

  // A legacy message-insert trigger sets conversations.updated_at to each
  // turn's historical timestamp. Restore the event time after backfilling.
  const { error: conversationError } = await tenantDatabase()
    .from("conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", params.conversationId)
    .eq("site_id", params.siteId);
  if (conversationError) {
    throw new Error(`Failed to refresh Voice conversation: ${conversationError.message}`);
  }
}