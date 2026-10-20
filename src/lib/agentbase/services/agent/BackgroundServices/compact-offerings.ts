export const CONFIGURED_OFFERINGS_MAX_CHARS = 2_000;
const MAX_NAME_CHARS = 100;
const MAX_INSPECTED_ENTRIES = 80;
const LIVE_CATALOG_NOTICE = '\nConfigured offerings are background only, not a live catalog. Use catalog_commerce (action="list", search) for current items, prices and availability.\n';

function offeringArray(value: unknown): unknown[] | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    // Never fall back to serializing arbitrary settings, which can contain private data.
    return null;
  }
}

function offeringName(entry: unknown): string {
  const name = typeof entry === 'string' ? entry
    : entry && typeof entry === 'object' && 'name' in entry ? entry.name : undefined;
  if (typeof name !== 'string') return '';
  // Slice before normalization: huge names must not consume the shared prompt budget.
  const shortened = name.slice(0, MAX_NAME_CHARS).replace(/\s+/g, ' ').trim();
  return shortened ? `${shortened}${name.length > MAX_NAME_CHARS ? '…' : ''}` : '';
}

function section(title: string, value: unknown, budget: number): string {
  const heading = `\n## ${title}\n`;
  const entries = offeringArray(value);
  if (!entries) return `${heading}Configured names unavailable; all entries omitted (count unknown).\n`;
  const total = entries.length;
  const summary = (shown: number) => `Shown ${shown} of ${total}; omitted ${total - shown} configured offerings.\n`;
  // Reserve the largest possible counters so the final section is always bounded.
  const reserve = `Shown ${total} of ${total}; omitted ${total} configured offerings.\n`.length;
  let text = heading;
  let shown = 0;
  for (let index = 0; index < Math.min(total, MAX_INSPECTED_ENTRIES); index++) {
    const name = offeringName(entries[index]);
    if (!name) continue;
    const line = `- ${JSON.stringify(name)}\n`;
    if (text.length + line.length + reserve > budget) break;
    text += line;
    shown++;
  }
  return text + summary(shown);
}

/** Names only, one fixed budget shared across products AND services. No database reads. */
export function compactConfiguredOfferings(products: unknown, services: unknown): string {
  const configured = [
    ...(products ? [{ title: 'Products', value: products }] : []),
    ...(services ? [{ title: 'Services', value: services }] : []),
  ];
  if (!configured.length) return '';
  const budget = Math.floor((CONFIGURED_OFFERINGS_MAX_CHARS - LIVE_CATALOG_NOTICE.length) / configured.length);
  return configured.map(({ title, value }) => section(title, value, budget)).join('') + LIVE_CATALOG_NOTICE;
}