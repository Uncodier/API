/** Keep opaque chat IDs, phone prefixes and mailbox identities unchanged after
 * stripping the provider namespace. Admission and reply verification must agree. */
export function inboundZavuRecipient(from: string): string {
  return from.slice(from.indexOf(':') + 1);
}