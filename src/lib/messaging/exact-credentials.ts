import { supabaseAdmin } from '@/lib/database/supabase-client';
import { decryptToken } from '@/lib/utils/token-decryption';

/** Account-labelled credentials only; old singleton tokens must be unambiguous. */
export async function selectedToken(siteId: string, tokenType: string, identifier: string | string[]): Promise<any> {
  const { data, error } = await supabaseAdmin.from('secure_tokens').select('*')
    .eq('site_id', siteId).eq('token_type', tokenType);
  if (error) throw error;
  const identifiers = Array.isArray(identifier) ? identifier : [identifier];
  const matches = (data || []).filter(t => identifiers.includes(t.identifier));
  const token = matches.length === 1 ? matches[0]
    : !matches.length && data?.length === 1 && !data[0].identifier ? data[0] : null;
  if (!token) return null;
  const encrypted = token.encrypted_value || token.token_value || token.value;
  const plaintext = typeof encrypted === 'string' ? decryptToken(encrypted) : null;
  if (!plaintext) return null;
  try { return JSON.parse(plaintext); } catch { return plaintext; }
}