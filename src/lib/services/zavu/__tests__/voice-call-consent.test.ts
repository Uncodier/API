import { getVoiceCallEligibility } from "../voice-call-consent";

describe("getVoiceCallEligibility", () => {
  it.each([
    {},
    { do_not_call: null, voice_call_consent_status: null, voice_call_consent_at: null },
    { do_not_call: false, voice_call_consent_status: "unknown" },
    { voice_call_consent_status: "unknown", voice_call_consent_at: "invalid" },
    { voice_call_consent_status: "" },
    { voice_call_consent_status: "unrecognized" },
    { voice_call_consent_status: "granted" },
    { voice_call_consent_status: "granted", voice_call_consent_at: null },
    { voice_call_consent_status: "granted", voice_call_consent_at: "" },
    { voice_call_consent_status: "granted", voice_call_consent_at: "invalid" },
    { voice_call_consent_status: "granted", voice_call_consent_at: "2026-09-21T12:00:00.000Z" },
  ])("allows records without an explicit opt-out: %j", (lead) => {
    expect(getVoiceCallEligibility(lead)).toEqual({ allowed: true });
  });

  it("gives the do-not-call flag precedence over consent", () => {
    expect(getVoiceCallEligibility({
      do_not_call: true,
      voice_call_consent_status: "granted",
      voice_call_consent_at: "2026-09-21T12:00:00.000Z",
    })).toEqual({
      allowed: false,
      reason: "Lead is on the do-not-call list",
    });
  });

  it.each(["revoked", "denied"])("blocks explicit %s opt-out regardless of timestamp", (status) => {
    for (const timestamp of [undefined, null, "", "invalid", "2026-09-21T12:00:00.000Z"]) {
      expect(getVoiceCallEligibility({
        do_not_call: false,
        voice_call_consent_status: status,
        voice_call_consent_at: timestamp,
      })).toEqual({ allowed: false, reason: "Lead has opted out of Voice calls" });
    }
  });

  it.each([undefined, null, "unknown", "granted", "revoked", "denied"])("DNC takes precedence over %s", (status) => {
    expect(getVoiceCallEligibility({ do_not_call: true, voice_call_consent_status: status }))
      .toEqual({ allowed: false, reason: "Lead is on the do-not-call list" });
  });
});
