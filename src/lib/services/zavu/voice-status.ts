export type StoredVoiceCallStatus =
  | "placing"
  | "placement_unknown"
  | "queued"
  | "ringing"
  | "in_progress"
  | "completed"
  | "failed"
  | "busy"
  | "no_answer"
  | "canceled";

const STORED_STATUSES = new Set<StoredVoiceCallStatus>([
  "placing",
  "placement_unknown",
  "queued",
  "ringing",
  "in_progress",
  "completed",
  "failed",
  "busy",
  "no_answer",
  "canceled",
]);

export function normalizeVoiceDeliveryStatus(
  status: unknown,
  fallback: StoredVoiceCallStatus = "in_progress"
): StoredVoiceCallStatus {
  if (status === "initiated") return "ringing";
  if (status === "answered") return "in_progress";
  if (status === "cancelled") return "canceled";
  return typeof status === "string"
    && STORED_STATUSES.has(status as StoredVoiceCallStatus)
    ? status as StoredVoiceCallStatus
    : fallback;
}
