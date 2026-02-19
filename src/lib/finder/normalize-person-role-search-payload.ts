/**
 * Normalization for Forager person_role_search body fields.
 * String fields that "support a boolean text search query" accept arrays from clients;
 * we convert them to "a OR b OR c" before forwarding to upstream.
 */

export const PERSON_ROLE_SEARCH_BOOLEAN_FIELDS = [
  'role_title',
  'role_description',
  'person_name',
  'person_headline',
  'person_description',
  'organization_description',
  'job_post_title',
  'job_post_description'
] as const;

export function normalizeBooleanSearchString(val: unknown): string | undefined {
  if (val == null) return undefined;
  if (typeof val === 'string') return val.trim() || undefined;
  if (Array.isArray(val)) {
    const parts = val
      .filter((v): v is string => typeof v === 'string')
      .map((s) => s.trim())
      .filter(Boolean);
    return parts.length ? parts.join(' OR ') : undefined;
  }
  return String(val).trim() || undefined;
}

/**
 * Mutates obj: normalizes boolean search fields (array -> "a OR b") and optionally page.
 */
export function normalizePersonRoleSearchPayload(
  obj: Record<string, unknown>,
  options: { normalizePage?: (val: unknown) => unknown } = {}
): void {
  const { normalizePage } = options;

  if (normalizePage && 'page' in obj) {
    obj.page = normalizePage(obj.page);
  }

  for (const key of PERSON_ROLE_SEARCH_BOOLEAN_FIELDS) {
    if (!(key in obj)) continue;
    const normalized = normalizeBooleanSearchString(obj[key]);
    if (normalized !== undefined) {
      obj[key] = normalized;
    } else {
      delete obj[key];
    }
  }
}
