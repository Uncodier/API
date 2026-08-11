import { supabaseAdmin } from '@/lib/database/supabase-client';

export const SUPPORTED_EMAIL_LOCALES = ['en', 'es', 'fr', 'de', 'ja'] as const;

export type EmailLocale = (typeof SUPPORTED_EMAIL_LOCALES)[number];

export const DEFAULT_EMAIL_LOCALE: EmailLocale = 'en';

const BCP47_BY_LOCALE: Record<EmailLocale, string> = {
  en: 'en-US',
  es: 'es-ES',
  fr: 'fr-FR',
  de: 'de-DE',
  ja: 'ja-JP',
};

export function isEmailLocale(value: unknown): value is EmailLocale {
  return typeof value === 'string' && (SUPPORTED_EMAIL_LOCALES as readonly string[]).includes(value);
}

export function normalizeEmailLocale(value: unknown, fallback: EmailLocale = DEFAULT_EMAIL_LOCALE): EmailLocale {
  const parsed = tryNormalizeEmailLocale(value);
  return parsed ?? fallback;
}

export function tryNormalizeEmailLocale(value: unknown): EmailLocale | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().split(/[-_]/)[0];
  return isEmailLocale(normalized) ? normalized : null;
}

export function toBcp47(locale: EmailLocale): string {
  return BCP47_BY_LOCALE[locale] || BCP47_BY_LOCALE.en;
}

export function formatEmailDate(
  date: Date | string | number,
  locale: EmailLocale,
  options?: Intl.DateTimeFormatOptions
): string {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(toBcp47(locale), options ?? {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export interface ResolveEmailLocaleParams {
  siteId?: string | null;
  userId?: string | null;
  leadId?: string | null;
  /** Explicit override (e.g. user_metadata.locale from auth hook) */
  explicitLocale?: string | null;
}

/**
 * Resolve locale for outbound email:
 * explicit → user profile language → lead language → site default_locale → en
 */
export async function resolveEmailLocale(params: ResolveEmailLocaleParams): Promise<EmailLocale> {
  const { siteId, userId, leadId, explicitLocale } = params;

  if (explicitLocale) {
    const fromExplicit = tryNormalizeEmailLocale(explicitLocale);
    if (fromExplicit) return fromExplicit;
  }

  if (userId) {
    try {
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('language')
        .eq('id', userId)
        .maybeSingle();
      const fromProfile = tryNormalizeEmailLocale(profile?.language);
      if (fromProfile) return fromProfile;
    } catch (err) {
      console.warn('[email-locale] Failed to load profile language:', err);
    }
  }

  if (leadId) {
    try {
      const { data: lead } = await supabaseAdmin
        .from('leads')
        .select('language')
        .eq('id', leadId)
        .maybeSingle();
      const fromLead = tryNormalizeEmailLocale(lead?.language);
      if (fromLead) return fromLead;
    } catch (err) {
      console.warn('[email-locale] Failed to load lead language:', err);
    }
  }

  if (siteId) {
    const siteLocale = await getSiteDefaultLocale(siteId);
    if (siteLocale) return siteLocale;
  }

  return DEFAULT_EMAIL_LOCALE;
}

export async function getSiteDefaultLocale(siteId: string): Promise<EmailLocale | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from('settings')
      .select('default_locale')
      .eq('site_id', siteId)
      .maybeSingle();

    if (error) {
      console.warn('[email-locale] Failed to load settings.default_locale:', error.message);
      return null;
    }

    const fromSite = tryNormalizeEmailLocale(data?.default_locale);
    if (fromSite) return fromSite;
  } catch (err) {
    console.warn('[email-locale] Exception loading site default_locale:', err);
  }
  return null;
}

/** Human-readable language name for LLM compose instructions */
export function localeDisplayName(locale: EmailLocale): string {
  const names: Record<EmailLocale, string> = {
    en: 'English',
    es: 'Spanish',
    fr: 'French',
    de: 'German',
    ja: 'Japanese',
  };
  return names[locale];
}

export function buildComposeLanguageInstruction(locale: EmailLocale): string {
  return `Write the email subject and body entirely in ${localeDisplayName(locale)} (${locale}). Do not mix languages.`;
}
