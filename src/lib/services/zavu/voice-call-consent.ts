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
  // Only explicit call opt-outs block placement. Contact-storage consent is separate.
  // Preserve legacy "denied" records as opt-outs even though current writers use "revoked".
  if (lead.voice_call_consent_status === "revoked" || lead.voice_call_consent_status === "denied") {
    return {
      allowed: false,
      reason: "Lead has opted out of Voice calls",
    };
  }
  return { allowed: true };
}
