import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { sendEmailCore } from '@/app/api/agents/tools/sendEmail/core';
import type { SetupEmailRequest } from './setup-email-request';

interface Receipt {
  success: boolean;
  status: 'sent' | 'skipped' | 'uncertain';
  messageId?: string;
  recipient?: string;
  sent_at?: string;
  reason?: string;
}
export const unconfirmedSetupEmail = (reason = 'delivery_unconfirmed') => ({
  success: false, status: 'uncertain' as const, unconfirmed: true, skipped: true, reason,
});
function confirmedReceipt(receipt: unknown, email: string): receipt is Receipt {
  if (!receipt || typeof receipt !== 'object') return false;
  const r = receipt as Receipt;
  return r.status === 'sent' && r.success === true
    && typeof r.messageId === 'string' && !!r.messageId.trim()
    && r.recipient === email && typeof r.sent_at === 'string' && Number.isFinite(Date.parse(r.sent_at));
}
const safeSkips = new Set(['INVALID_REQUEST', 'SITE_CONFIG_NOT_FOUND', 'RATE_LIMITED', 'EMAIL_NOT_CONFIGURED']);

/** Caller must verify the internal service credential before invoking this module. */
export async function dispatchSetupEmail({ operation_key, payload }: SetupEmailRequest) {
  const claimToken = randomUUID();
  const identity = {
    p_operation_key: operation_key, p_site_id: payload.site_id, p_payload: payload, p_claim_token: claimToken,
  };
  const claim = await supabaseAdmin.rpc('claim_setup_email_delivery', identity);
  // Fail closed even if a committed claim's RPC response was lost.
  if (claim.error || !claim.data) throw new Error('Setup email receipt storage unavailable');
  const state = claim.data.outcome;
  if (state === 'conflict') return { httpStatus: 409, body: unconfirmedSetupEmail('operation_payload_conflict') };
  if (state === 'site_unavailable') return { httpStatus: 404, body: { success: false, status: 'skipped', skipped: true, reason: 'site_unavailable' } };
  if (state === 'sent') {
    return { httpStatus: 200, body: confirmedReceipt(claim.data.receipt, payload.email)
      ? { ...claim.data.receipt, replayed: true } : unconfirmedSetupEmail('invalid_stored_receipt') };
  }
  if (state === 'skipped') {
    return { httpStatus: 200, body: { success: false, status: 'skipped', skipped: true, reason: claim.data.receipt?.reason || 'email_provider_skipped', replayed: true } };
  }
  if (state !== 'acquired') {
    return { httpStatus: 200, body: unconfirmedSetupEmail('prior_attempt_unconfirmed') };
  }

  let receipt: Receipt;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      sendEmailCore({ ...payload, disable_provider_fallback: true }),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Delivery confirmation timed out')), 60_000); }),
    ]);
    const id = result.external_message_id || result.email_id || result.envelope_id;
    if (result.success === true && result.status === 'sent' && typeof id === 'string' && id.trim()) {
      receipt = { success: true, status: 'sent', messageId: id, recipient: payload.email, sent_at: new Date().toISOString() };
    } else if (result.status === 'skipped' || (result.error?.code && safeSkips.has(result.error.code))) {
      receipt = { success: false, status: 'skipped', reason: result.error?.code || 'email_provider_skipped' };
    } else {
      receipt = { success: false, status: 'uncertain', reason: 'provider_confirmation_unavailable' };
    }
  } catch {
    // A timeout/error is not proof of non-delivery; it can follow acceptance.
    receipt = { success: false, status: 'uncertain', reason: 'provider_confirmation_unavailable' };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  try {
    const final = await supabaseAdmin.rpc('finalize_setup_email_delivery', {
      ...identity, p_state: receipt.status, p_receipt: receipt,
    });
    if (final.error || final.data?.outcome !== receipt.status) {
      return { httpStatus: 200, body: unconfirmedSetupEmail('receipt_confirmation_unavailable') };
    }
    if (receipt.status === 'sent') return { httpStatus: 200, body: receipt };
    return { httpStatus: 200, body: receipt.status === 'uncertain'
      ? unconfirmedSetupEmail(receipt.reason) : { ...receipt, skipped: true } };
  } catch {
    // Never turn lost persistence confirmation into permission to send again.
    return { httpStatus: 200, body: unconfirmedSetupEmail('receipt_confirmation_unavailable') };
  }
}