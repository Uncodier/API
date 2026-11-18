/** Plaintext details for the existing notification.message column; no new payload fields. */
export function notificationMessage(summary: string, facts: Array<[string, unknown]>): string {
  const sections = facts.flatMap(([label, value]) => {
    if (value === undefined || value === null || value === '') return [];
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (!text || text === '[]' || text === '{}') return [];
    return [`${label}: ${text}`];
  });
  return [summary, ...sections].join('\n\n');
}

/** Keep valid external email actions; never render an empty/unsafe primary CTA. */
export function emailAction(action: any, fallbackUrl: string, fallbackTitle = 'View details') {
  for (const candidate of [action?.url, action?.link]) {
    if (typeof candidate !== 'string') continue;
    try {
      const url = new URL(candidate);
      if (['https:', 'http:', 'mailto:', 'tel:'].includes(url.protocol) && !url.username && !url.password) {
        return { title: action.title || action.text || fallbackTitle, url: candidate };
      }
    } catch { /* Fall back to the known application entity route. */ }
  }
  return { title: fallbackTitle, url: fallbackUrl };
}

/** Caller-supplied markdown actions are optional; don't manufacture a destination. */
export function emailMarkdownLinks(message: string): string {
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return message.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, url) => {
    const action = emailAction({ url }, '');
    if (!action.url) return escape(label);
    return `<div style="text-align: center; margin: 32px 0 16px 0;"><a href="${escape(action.url)}" target="_blank" class="email-cta" style="background: #000000; background-color: #000000; background-image: linear-gradient(#000000, #000000); box-shadow: inset 0 0 0 999px #000000; color: #ffffff; border: 0; display: inline-block; font-weight: 600; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-size: 16px; text-align: center;"><span class="email-cta-label">${escape(label)}</span></a></div>`;
  });
}