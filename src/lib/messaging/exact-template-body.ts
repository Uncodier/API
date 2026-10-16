/** The non-destructive part of WhatsAppTemplateService's template canonicalization. */
export function canonicalExactTemplateBody(message: string): string {
  // Existing provider preparation truncates/prefixes these cases. Exact delivery must not.
  if (message.length > 1000) throw new Error('Exact WhatsApp template content exceeds 1000 characters.');
  const content = message.normalize('NFC')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
  if (content.length < 10) throw new Error('Exact WhatsApp template content needs at least 10 characters.');
  return content;
}