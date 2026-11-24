import type { RoutedContext } from './routed-text-store';

/** Only provider-origin addresses are known to already include the country code.
 * A local CRM phone, including a plausible-looking digit string, is not. */
export function providerPhone(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^(?:whatsapp:)?\+?[1-9]\d{6,14}$/.test(value)) return undefined;
  return `+${value.replace(/^whatsapp:/, '').replace(/^\+/, '')}`;
}

/** Allow formatting on stored contacts/display numbers but never rescue, prefix,
 * strip a trunk digit, or compare only the national portion of the number. */
export function explicitPhone(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const compact = value.replace(/[ ().-]/g, '');
  return /^(?:whatsapp:)?\+/.test(compact) ? providerPhone(compact) : undefined;
}

export class RoutedTextRecipientError extends Error {
  snapshot?: Pick<RoutedContext, 'role' | 'content' | 'metadata'>;
  constructor() { super('Verify the WhatsApp recipient in this conversation or supply a phone in international (+country code) format.'); }
}

/** The verified address can fill in a missing representation, never different
 * digits. A mutable contact cannot redirect an inbound conversation. */
export function routedRecipient(verified: string | undefined, contacts: unknown[], constraints: unknown[] = []): string {
  const recipient = verified ?? contacts.map(explicitPhone).find(Boolean);
  const values = [...contacts, ...constraints].filter(value => value != null && value !== '');
  if (!recipient || values.some(value => {
    const compact = typeof value === 'string' ? value.replace(/[ ().-]/g, '') : undefined;
    return providerPhone(compact) !== recipient;
  })) throw new RoutedTextRecipientError();
  return recipient;
}
