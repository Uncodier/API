export const MAX_UTM_LENGTH = 512;
const MAX_ATTRIBUTION_URL_LENGTH = 8_192;
const UTM_FIELDS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
] as const;
type UtmField = typeof UTM_FIELDS[number];
export type SessionAttribution = Record<UtmField, string | null>;

function landingUrlParams(url?: string): URLSearchParams | null {
  // Bound only fallback parsing; leave the existing landing URL contract intact.
  if (!url || url.length > MAX_ATTRIBUTION_URL_LENGTH) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
      ? parsed.searchParams : null;
  } catch {
    return null;
  }
}

function normalizeUrlUtm(value: string | null): string | null {
  // Do not truncate campaign labels or persist controls / malformed UTF-8.
  if (value === null || value.length > MAX_UTM_LENGTH
    || /[\u0000-\u001f\u007f-\u009f\ufffd]/.test(value)) return null;
  return value.trim() || null;
}

export function normalizeSessionAttribution(
  input: { url?: string } & Partial<Record<UtmField, string>>,
): SessionAttribution {
  const params = landingUrlParams(input.url);
  const attribution = {} as SessionAttribution;
  UTM_FIELDS.forEach(field => {
    // Explicit fields are already bounded by createSessionSchema. Preserve
    // nonblank values verbatim; URL values are decoded once, trimmed and bounded.
    const explicit = input[field];
    attribution[field] = explicit?.trim()
      ? explicit : normalizeUrlUtm(params?.get(field) ?? null);
  });
  // URLSearchParams.get deliberately uses the first duplicate, even if blank.
  return attribution;
}