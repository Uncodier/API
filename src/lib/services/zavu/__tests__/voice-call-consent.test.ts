import { getVoiceCallEligibility } from "../voice-call-consent";

describe("getVoiceCallEligibility", () => {
  it("requires explicit timestamped consent", () => {
    expect(getVoiceCallEligibility({
      do_not_call: false,
      voice_call_consent_status: "unknown",
      voice_call_consent_at: null,
    })).toMatchObject({ allowed: false });
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

  it("allows a lead with explicit timestamped consent", () => {
    expect(getVoiceCallEligibility({
      do_not_call: false,
      voice_call_consent_status: "granted",
      voice_call_consent_at: "2026-09-21T12:00:00.000Z",
    })).toEqual({ allowed: true });
  });
});
