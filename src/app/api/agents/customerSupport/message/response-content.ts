/** Internal absence markers must never become customer-visible messages. */
export function usableSupportContent(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const content = value.trim();
  const normalized = content.toLowerCase().replace(/[.!]+$/g, '').trim();
  if (!normalized || normalized === 'no response generated') return undefined;
  return content;
}