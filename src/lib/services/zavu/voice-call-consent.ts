export interface VoiceCallConsentRecord {
  do_not_call?: boolean | null;
  voice_call_consent_status?: string | null;
  voice_call_consent_at?: string | null;
}

export type VoiceCallEligibility =
  | { allowed: true }
  | { allowed: false; reason: string };

export function getVoiceCallEligibility(
  lead: VoiceCallConsentRecord
): VoiceCallEligibility {
  if (lead.do_not_call === true) {
    return { allowed: false, reason: "Lead is on the do-not-call list" };
  }
  if (
    lead.voice_call_consent_status !== "granted"
    || !lead.voice_call_consent_at
  ) {
    return {
      allowed: false,
      reason: "Lead has not granted explicit Voice call consent",
    };
  }
  if (Number.isNaN(Date.parse(lead.voice_call_consent_at))) {
    return {
      allowed: false,
      reason: "Lead Voice call consent timestamp is invalid",
    };
  }
  return { allowed: true };
}
