import { supabaseAdmin } from '@/lib/database/supabase-client';

const notes: Record<string, string> = {
  en: 'Customer support agent is disabled. No automatic response will be sent.',
  es: 'El agente de atención al cliente está deshabilitado. No se enviará ninguna respuesta automática.',
  fr: 'L’agent du service client est désactivé. Aucune réponse automatique ne sera envoyée.',
  de: 'Der Kundendienst-Agent ist deaktiviert. Es wird keine automatische Antwort gesendet.',
  ja: 'カスタマーサポートエージェントは無効です。自動応答は送信されません。',
};

export async function disabledSupportNote(siteId?: string): Promise<string> {
  if (!siteId) return notes.en;
  const { data, error } = await supabaseAdmin
    .schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public')
    .from('settings').select('default_locale').eq('site_id', siteId).maybeSingle();
  if (error) throw error;
  const locale = String(data?.default_locale || 'en').toLowerCase().split(/[-_]/)[0];
  return notes[locale] || notes.en;
}