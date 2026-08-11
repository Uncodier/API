import type { EmailLocale } from '../email-locale';
import { DEFAULT_EMAIL_LOCALE } from '../email-locale';

export type MessageDict = Record<string, string>;

export function interpolate(template: string, vars?: Record<string, string | number | undefined | null>): string {
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = vars[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

export function pickMessage(
  catalogs: Partial<Record<EmailLocale, MessageDict>>,
  locale: EmailLocale,
  key: string,
  vars?: Record<string, string | number | undefined | null>
): string {
  const primary = catalogs[locale]?.[key];
  const fallback = catalogs[DEFAULT_EMAIL_LOCALE]?.[key];
  const template = primary ?? fallback ?? key;
  return interpolate(template, vars);
}
