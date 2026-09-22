import { zavuFetch } from "./client";

export type ZavuVoiceCallStatus =
  | "queued"
  | "initiated"
  | "ringing"
  | "answered"
  | "in_progress"
  | "completed"
  | "failed"
  | "busy"
  | "no_answer"
  | "canceled"
  | "cancelled";

export interface ZavuVoiceCallTurn {
  seq: number;
  role: "user" | "assistant" | "tool";
  text: string;
  startedAt?: string | null;
  endedAt?: string | null;
}

export interface ZavuVoiceCall {
  id: string;
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  status: ZavuVoiceCallStatus;
  endReason?: string | null;
  answeredAt?: string | null;
  endedAt?: string | null;
  durationSeconds?: number | null;
  turnCount?: number | null;
  transcript?: ZavuVoiceCallTurn[];
  cost?: number | null;
  metadata?: Record<string, string>;
  createdAt: string;
  updatedAt?: string;
}

export interface PlaceVoiceCallInput {
  to: string;
  senderId: string;
  greeting?: string;
  language?: string;
  maxDurationMinutes?: number;
  metadata?: Record<string, string>;
}

function unwrapCall(payload: unknown): ZavuVoiceCall {
  const envelope = payload && typeof payload === "object"
    ? payload as { call?: unknown; data?: unknown }
    : undefined;
  const candidate = envelope?.call ?? envelope?.data ?? payload;
  if (!candidate || typeof candidate !== "object") {
    throw new Error("Zavu voice call response is missing call data");
  }
  const call = candidate as Partial<ZavuVoiceCall>;
  if (!call.id || !call.status || !call.to) {
    throw new Error("Zavu voice call response is missing required fields");
  }
  return call as ZavuVoiceCall;
}

export async function placeVoiceCall(
  input: PlaceVoiceCallInput
): Promise<ZavuVoiceCall> {
  return unwrapCall(
    await zavuFetch("/calls", {
      method: "POST",
      body: JSON.stringify(input),
    })
  );
}

export async function getVoiceCall(callId: string): Promise<ZavuVoiceCall> {
  return unwrapCall(
    await zavuFetch(`/calls/${encodeURIComponent(callId)}`)
  );
}

export async function hangupVoiceCall(callId: string): Promise<ZavuVoiceCall> {
  return unwrapCall(
    await zavuFetch(`/calls/${encodeURIComponent(callId)}/hangup`, {
      method: "POST",
    })
  );
}
