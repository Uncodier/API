const DOMAIN_PATTERN =
  /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function normalizeBrowserAllowedDomains(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.flatMap((entry) => {
    if (typeof entry !== 'string') return [];
    const normalized = entry.trim().toLowerCase().replace(/\.$/, '');
    return DOMAIN_PATTERN.test(normalized) ? [normalized] : [];
  })));
}

export function isBrowserHostnameAllowed(
  hostname: string,
  allowedDomains: string[],
): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, '');
  return allowedDomains.some((pattern) => {
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(2);
      return normalized.endsWith(`.${suffix}`);
    }
    return normalized === pattern;
  });
}
