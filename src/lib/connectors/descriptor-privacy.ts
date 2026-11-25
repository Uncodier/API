/** The structural schema allowlist is not a privacy check: enum literals, field names or
 * patterns can repeat opaque values from the current authenticated binding. Never send
 * a partially redacted contract: changing constraints would change the approved action. */
export function descriptorContainsPrivateValue(schema: Record<string, unknown>, values: ReadonlyArray<string | null | undefined>): boolean {
  const secrets = values.filter((value): value is string => typeof value === 'string' && value.length > 0);
  const matches = (text: string) => secrets.some(value => text === value || (value.length >= 12 && text.includes(value)));
  const visit = (value: unknown): boolean => typeof value === 'string' ? matches(value)
    : Array.isArray(value) ? value.some(visit)
    : value !== null && typeof value === 'object' && Object.entries(value).some(([k,v]) => matches(k) || visit(v));
  return visit(schema);
}
