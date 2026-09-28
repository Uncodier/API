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

/** Materialize only spoken turns; retain the full, unmodified call on the delivery. */
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
    if (turn?.role !== "user" && turn?.role !== "assistant") return [];
    const content = compactSpeech(turn.text);
    if (!content) return [];
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
      role: turn.role,
      content,
      created_at: new Date(lastTimestamp).toISOString(),
      custom_data: {
        source: "zavu_voice_transcript",
        channel_delivery: true,
        voice_mode: "agent_call",
        call_direction: params.call.direction,
        provider_call_id: params.call.id,
        voice_call_delivery_id: params.deliveryId,
        transcript_seq: turn.seq,
        status: turn.role === "user" ? "received" : "sent",
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