export const MAX_VOICE_PHONE_CANDIDATES = 50;

function cleanPhone(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 80) return undefined;
  return value.trim().replace(/[\s().-]/g, "");
}

/** Keep provider identity strict: never infer its country or remove its digits. */
export function normalizeVoiceIdentityPhone(value: unknown): string | undefined {
  let phone = cleanPhone(value);
  if (!phone) return undefined;
  if (phone.startsWith("00")) phone = `+${phone.slice(2)}`;
  return /^\+[1-9]\d{6,14}$/.test(phone) ? phone : undefined;
}

function canonicalSearchPhone(phone: string): string {
  // Mexico removed the mobile-only 1 after +52. This is a search alias only:
  // leave the authoritative caller, stored profiles and deterministic IDs intact.
  return /^\+521\d{10}$/.test(phone) ? `+52${phone.slice(4)}` : phone;
}

/** Compare CRM formats against an authoritative international caller, not arbitrary suffixes. */
export function matchesVoiceLeadPhone(storedValue: unknown, callerValue: string): boolean {
  const caller = normalizeVoiceIdentityPhone(callerValue);
  const stored = cleanPhone(storedValue);
  if (!caller || !stored) return false;
  const canonicalCaller = canonicalSearchPhone(caller);
  // Bare ten-digit values are the CRM's Mexican national format. Treating them
  // as international too could associate a Mexican contact with a Danish caller
  // (4532345678 is +52 4532345678, not an implicit +45 32345678).
  const international = normalizeVoiceIdentityPhone(stored)
    || (stored.length !== 10 && /^[1-9]\d{6,14}$/.test(stored) ? `+${stored}` : undefined);
  if (international && canonicalSearchPhone(international) === canonicalCaller) return true;

  // The CRM's legacy national format is Mexican. Only allow all ten national
  // digits when the provider explicitly supplies +52; never infer other countries.
  return /^\+52\d{10}$/.test(canonicalCaller)
    && /^[1-9]\d{9}$/.test(stored)
    && stored === canonicalCaller.slice(3);
}

/** Broad SQL candidate filter; callers MUST apply matchesVoiceLeadPhone before reuse. */
export function voiceLeadPhoneSearchPattern(callerValue: string): string {
  const caller = normalizeVoiceIdentityPhone(callerValue);
  if (!caller) throw new Error("Invalid Voice caller phone for lead lookup");
  const canonical = canonicalSearchPhone(caller);
  const digits = /^\+52\d{10}$/.test(canonical) ? canonical.slice(3) : canonical.slice(1);
  return `%${digits.split("").join("%")}%`;
}