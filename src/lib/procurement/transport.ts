import { supabaseAdmin } from '@/lib/database/supabase-client';

export class ProcurementError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
    this.name = 'ProcurementError';
  }
}

export async function dispatchProcurement(scope: { siteId: string; userId: string }, operation: string, args: Record<string, unknown>) {
  // No retries on writes: a lost response is not evidence of rollback.
  let result;
  try {
    result = await supabaseAdmin.rpc('procurement_mcp_dispatch', {
      p_site: scope.siteId, p_actor: scope.userId, p_operation: operation, p_args: args,
    });
  } catch {
    throw new ProcurementError('outcome_unknown', 503, 'Procurement response unavailable. Read the current record before retrying; reuse the same idempotency key for quotations/receipts.');
  }
  if (result.error) {
    const code = result.error.code;
    if (code === 'P0002') throw new ProcurementError('not_found', 404, 'Procurement record not found in this workspace.');
    if (code === '55000') throw new ProcurementError('not_ready', 409, 'Procurement is not configured or ready. Verify the saved policy and required module migrations.');
    if (['40001', '23505', 'PT409'].includes(code)) throw new ProcurementError('conflict', 409, 'Record, policy or decision changed. Reload before continuing; do not blindly retry.');
    if (code === '42501') throw new ProcurementError('forbidden', 403, 'Procurement access denied. Check membership, manager role, location restrictions and approver eligibility.');
    if (['22023', '23514', '23502', '23503', '22003', '22P02', '22007'].includes(code)) throw new ProcurementError('invalid_transition', 400, 'Procurement cannot progress. Check state, versions, dates, pricing, supplier eligibility, policy and remaining quantities.');
    if (['PGRST202', '42883', '42P01'].includes(code)) throw new ProcurementError('migration_required', 503, 'Required procurement module or MCP bridge migration is unavailable.');
    throw new ProcurementError('unavailable', 503, 'Procurement storage unavailable. Inspect current state before retrying.');
  }
  return result.data;
}