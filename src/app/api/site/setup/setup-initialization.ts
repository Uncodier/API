import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { SiteSetupError } from './setup-request';

const billingResultSchema = z.object({
  success: z.literal(true),
  outcome: z.enum(['initialized', 'already_initialized']),
  billing_id: z.string().uuid(),
  credits_granted: z.number().finite().nonnegative(),
  credits_available: z.number().finite().nonnegative(),
});

export async function initializeSetupBilling(siteId: string): Promise<void> {
  try {
    // The atomic RPC exclusively owns allowances, balances, and financial ledger writes.
    const { data, error } = await supabaseAdmin.rpc('initialize_site_billing', { p_site_id: siteId });
    if (error || !billingResultSchema.safeParse(data).success) {
      throw new Error('Invalid billing initialization result');
    }
  } catch {
    // No direct financial fallback and no workflow launch when billing is unconfirmed.
    console.error('[Site setup] Atomic billing initialization failed');
    throw new SiteSetupError(
      503,
      'BILLING_INITIALIZATION_FAILED',
      'Site billing could not be initialized. Please retry setup later',
    );
  }
}

export async function persistSetupLocale(siteId: string, defaultLocale: string): Promise<void> {
  // Keep settings persistence best-effort, as before; billing is the mandatory launch gate.
  try {
    const { data: existing, error: readError } = await supabaseAdmin.from('settings')
      .select('id').eq('site_id', siteId).maybeSingle();
    if (readError) throw readError;
    const { error } = existing
      ? await supabaseAdmin.from('settings').update({ default_locale: defaultLocale }).eq('site_id', siteId)
      : await supabaseAdmin.from('settings').insert({ site_id: siteId, default_locale: defaultLocale });
    if (error) throw error;
  } catch {
    console.error('[Site setup] Could not persist the default locale');
  }
}