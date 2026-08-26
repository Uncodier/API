import {
  arePhoneNumbersEquivalent,
  normalizePhoneForSearch,
  normalizePhoneForStorage,
} from '@/lib/utils/phone-normalizer';

/**
 * Last 10 digits of a phone number. Mexican WhatsApp still sends +521XXXXXXXXXX
 * while the number is stored as +52XXXXXXXXXX; both share the same last 10 digits.
 */
export function lastTenPhoneDigits(phone: string): string | null {
  const digits = String(phone || '').replace(/[^\d]/g, '');
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

/**
 * Compact set of identifier fragments to search `secure_tokens.identifier`.
 * Includes the raw Twilio To, the MX-canonical +52 form, and last-10 digits.
 */
export function whatsappIdentifierSearchKeys(incomingNumber: string): string[] {
  const incoming = String(incomingNumber || '').trim();
  if (!incoming) return [];

  const keys = new Set<string>();
  keys.add(incoming);
  keys.add(incoming.replace(/^whatsapp:/i, ''));

  const canonical = normalizePhoneForStorage(incoming);
  if (canonical) keys.add(canonical);

  const last10 = lastTenPhoneDigits(incoming);
  if (last10) keys.add(last10);

  for (const variant of normalizePhoneForSearch(incoming)) {
    if (variant.startsWith('+') || variant.length >= 10) {
      keys.add(variant);
    }
  }

  return Array.from(keys).filter(Boolean);
}

export function storedWhatsAppIdentifierMatches(
  storedIdentifier: string | null | undefined,
  incomingNumber: string
): boolean {
  if (!storedIdentifier || !incomingNumber) return false;
  const stored = storedIdentifier.trim();
  const incoming = incomingNumber.replace(/^whatsapp:/i, '').trim();
  if (!stored || !incoming) return false;
  if (stored === incoming) return true;
  if (arePhoneNumbersEquivalent(stored, incoming)) return true;

  const last10 = lastTenPhoneDigits(incoming);
  if (!last10) return false;
  const storedDigits = stored.replace(/[^\d]/g, '');
  return storedDigits.length >= 10 && storedDigits.endsWith(last10);
}

export function pickMatchingWhatsAppToken<T extends { identifier?: string | null }>(
  tokens: T[],
  incomingNumber: string
): T | null {
  if (!tokens?.length) return null;
  const matched = tokens.filter((token) =>
    storedWhatsAppIdentifierMatches(token.identifier, incomingNumber)
  );
  return matched[0] || (tokens.length === 1 ? tokens[0] : null);
}

/**
 * Twilio WhatsApp From candidates for a stored business number.
 * Mexican numbers are stored as +52XXXXXXXXXX but the WhatsApp sender is +521XXXXXXXXXX.
 * Prefer the +521 form first so outbound does not hit Twilio 63007.
 */
export function twilioWhatsAppFromCandidates(storedNumber: string | null | undefined): string[] {
  const stored = String(storedNumber || '').replace(/^whatsapp:/i, '').replace(/[\s\-()]/g, '').trim();
  if (!stored) return [];

  const last10 = lastTenPhoneDigits(stored);
  const candidates: string[] = [];

  if (last10 && /^\+52\d{10}$/.test(stored)) {
    candidates.push(`+521${last10}`);
  }
  candidates.push(stored);
  if (last10 && /^\+521\d{10}$/.test(stored)) {
    candidates.push(`+52${last10}`);
  }

  return Array.from(new Set(candidates));
}
