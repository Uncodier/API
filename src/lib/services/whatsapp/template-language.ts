import { supabaseAdmin } from '@/lib/database/supabase-client';

// Meta template language codes, not browser Accept-Language. Regional variants
// without a distinct Meta code use their supported base language (fr-CA -> fr).
const LANGUAGES = new Set('af sq ar az bn bg ca zh_CN zh_HK zh_TW hr cs da nl en en_GB en_US et fil fi fr ka de el gu ha he hi hu id ga it ja kn kk rw ko ky lo lv lt mk ms ml mr nb fa pl pt_BR pt_PT pa ro ru sr sk sl es es_AR es_ES es_MX sw sv ta te th tr uk ur uz vi zu'.split(' '));
export function whatsappTemplateLanguage(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'en';
  if (typeof value !== 'string') throw new Error('Invalid site template language');
  const parts = value.trim().replace(/_/g, '-').split('-');
  const base = parts[0].toLowerCase();
  const candidate = parts.length === 2 ? `${base}_${parts[1].toUpperCase()}` : base;
  if (LANGUAGES.has(candidate)) return candidate;
  if (LANGUAGES.has(base) && parts.length <= 2) return base;
  throw new Error('Unsupported site WhatsApp template language');
}

export async function loadSiteTemplateLanguage(siteId: string): Promise<string> {
  const { data, error } = await supabaseAdmin.from('settings').select('default_locale').eq('site_id', siteId).maybeSingle();
  if (error) throw new Error('Site template language is unavailable');
  return whatsappTemplateLanguage(data?.default_locale);
}