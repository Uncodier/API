import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';

const bindingSchema = z.object({ supplier_id: z.string().uuid(), version: z.number().int().nonnegative(),
  contact_id: z.string().uuid(), channel: z.enum(['email', 'whatsapp', 'sms']) }).strict();

export async function resolveSupplierTarget(client: SupabaseClient, siteId: string, channel: string, binding: unknown) {
  const parsed = bindingSchema.safeParse(binding);
  if (!parsed.success || parsed.data.channel !== channel) return null;
  const { supplier_id, version, contact_id } = parsed.data;
  const { data, error } = await client.from('suppliers').select('supplier_contacts(id, email, phone)')
    .eq('site_id', siteId).eq('id', supplier_id).eq('version', version).maybeSingle();
  const contact = !error && data?.supplier_contacts?.find(item => item.id === contact_id);
  if (!contact) return null;
  if (channel === 'email') {
    const address = z.string().trim().email().max(254).safeParse(contact.email);
    return address.success ? { leadEmail: address.data } : null;
  }
  const phone = typeof contact.phone === 'string' ? contact.phone.replace(/[ ().-]/g, '').replace(/^whatsapp:/, '') : '';
  return /^\+[1-9]\d{6,14}$/.test(phone) ? { leadPhone: phone } : null;
}