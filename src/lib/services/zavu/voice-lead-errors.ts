export type VoiceLeadField = "name" | "email" | "phone" | "callback_phone" | "company" | "consent";

const fieldGuidance: Record<VoiceLeadField, string> = {
  name: "name: confirm a nonblank caller name (maximum 200 characters)",
  email: "email: confirm one complete address, convert spoken separators such as arroba/punto to @/., and send it without spaces; ask the caller to spell only the unclear part, never guess or request a different email just because formatting failed",
  phone: "phone: use only the confirmed calling number in international format, or omit this field; a different contact number belongs in callback_phone",
  callback_phone: "callback_phone: confirm the country code and send the alternate contact number in international format; never guess a country code",
  company: "company: send the company name as text (maximum 200 characters) or omit it",
  consent: "consent: obtain explicit agreement to store contact details and be contacted, then send boolean true",
};

type VoiceLeadErrorCode =
  | "VOICE_LEAD_INVALID_DETAILS"
  | "VOICE_LEAD_CONSENT_REQUIRED"
  | "VOICE_LEAD_CALLER_PHONE_UNAVAILABLE"
  | "VOICE_LEAD_PHONE_MISMATCH";

/** Fixed codes/field names are safe diagnostics; never include caller values. */
export class VoiceLeadValidationError extends Error {
  readonly fields: VoiceLeadField[];

  constructor(readonly code: VoiceLeadErrorCode, fields: VoiceLeadField[] = []) {
    const safeFields = Array.from(new Set(fields.filter((field) =>
      Object.prototype.hasOwnProperty.call(fieldGuidance, field)
    )));
    const message = code === "VOICE_LEAD_CALLER_PHONE_UNAVAILABLE"
      ? "A trusted caller phone in international format is required for Voice lead identification. This is missing call context, not an email error; request human assistance."
      : code === "VOICE_LEAD_PHONE_MISMATCH"
        ? "Confirmed phone must match the trusted Voice caller phone. For a different contact number, omit phone and supply callback_phone after confirming its country code. Do not change the email."
        : code === "VOICE_LEAD_CONSENT_REQUIRED"
          ? "Explicit caller consent is required to identify a Voice lead. Ask for agreement to store contact details and be contacted."
          : `Invalid Voice lead details. ${safeFields.map((field) => fieldGuidance[field]).join("; ")}. Keep the other confirmed details when retrying.`;
    super(message);
    this.name = "VoiceLeadValidationError";
    Object.setPrototypeOf(this, new.target.prototype);
    this.fields = safeFields;
  }
}