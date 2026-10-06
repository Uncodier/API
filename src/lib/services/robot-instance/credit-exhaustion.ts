import { supabaseAdmin } from '@/lib/database/supabase-client';
import { CreditService } from '@/lib/services/billing/CreditService';
import type { CreditExhaustionNotice } from '@/lib/services/billing/credit-exhaustion-message';
import { setUserMessageStatus } from '@/app/api/robots/instance/assistant/user-message-log';
import { RecoveryError } from './assistant-recovery-schema';

export interface CreditExhaustionNoticeParams {
  instanceId: string;
  siteId: string;
  userId?: string | null;
  eventId: string;
  userMessageLogId?: string | null;
  expectedGeneration?: number;
  requirementId?: string;
  planId?: string;
  stepId?: string;
  /** In-process ownership fence, rechecked after the potentially slow billing read. */
  beforeWrite?: () => Promise<void>;
}

const FALLBACK_MESSAGE = 'Tus créditos se han agotado para continuar este ciclo. La próxima fecha de reinicio no está disponible. El trabajo pendiente no se ha marcado como completado. Puedes añadir créditos o reanudar cuando se renueven.';
const PAUSED_MESSAGE = 'El ciclo se ha pausado; el trabajo pendiente no se ha marcado como completado. Puedes reanudar cuando dispongas de créditos.';

/** Pause and leave a visible notice; this does not complete work or stop a sandbox. */
export async function persistCreditExhaustionNotice(
  params: CreditExhaustionNoticeParams,
): Promise<CreditExhaustionNotice> {
  let notice: CreditExhaustionNotice;
  try {
    const billingNotice = await CreditService.getCreditExhaustionNotice(params.siteId);
    notice = { ...billingNotice, message: `${billingNotice.message} ${PAUSED_MESSAGE}` };
  } catch {
    notice = { message: FALLBACK_MESSAGE, nextResetAt: null, available: null };
  }

  // Fence after the billing read and before any instance/notice writes. Only the
  // exact original action may be paused; never sweep other running user actions.
  await params.beforeWrite?.();
  if (params.expectedGeneration !== undefined && !params.userMessageLogId) {
    throw new RecoveryError('inactive');
  }
  if (params.userMessageLogId && !await setUserMessageStatus(
    params.userMessageLogId, 'paused', params.expectedGeneration,
  )) {
    throw new RecoveryError('inactive');
  }

  const updateStatus = async () => {
    const { error } = await supabaseAdmin.from('remote_instances')
      .update({ status: 'paused', updated_at: new Date().toISOString() })
      .eq('id', params.instanceId).eq('site_id', params.siteId);
    if (error) throw new Error(`Failed to pause robot for credits: ${error.message}`);
  };
  const persistNotice = async (): Promise<CreditExhaustionNotice> => {
    const { data: existing, error: lookupError } = await supabaseAdmin.from('instance_logs')
      .select('id, message, details')
      .eq('instance_id', params.instanceId).eq('site_id', params.siteId)
      .eq('log_type', 'agent_action')
      .eq('details->>event_id', params.eventId)
      .eq('details->>event', 'credits_exhausted')
      .limit(1).maybeSingle();
    if (lookupError) throw new Error(`Failed to check credit exhaustion notice: ${lookupError.message}`);
    if (existing) {
      // Durable retries return the already-visible notice, not a newly read date.
      return {
        message: existing.message,
        nextResetAt: existing.details?.next_credit_reset_at ?? null,
        available: existing.details?.credits_available ?? null,
      };
    }
    const { error } = await supabaseAdmin.from('instance_logs').insert({
      log_type: 'agent_action',
      level: 'info',
      message: notice.message,
      instance_id: params.instanceId,
      site_id: params.siteId,
      user_id: params.userId ?? null,
      details: {
        event: 'credits_exhausted',
        code: 'INSUFFICIENT_CREDITS',
        streaming: false,
        response_type: 'assistant_response',
        next_credit_reset_at: notice.nextResetAt,
        credits_available: notice.available,
        event_id: params.eventId,
        plan_id: params.planId ?? null,
        step_id: params.stepId ?? null,
        requirement_id: params.requirementId ?? null,
        ...(params.userMessageLogId ? { user_message_log_id: params.userMessageLogId } : {}),
      },
    });
    if (error) throw new Error(`Failed to persist credit exhaustion notice: ${error.message}`);
    return notice;
  };

  // A denied instance update must not suppress the visible log, or vice versa.
  const [updated, logged] = await Promise.allSettled([updateStatus(), persistNotice()]);
  const failures: unknown[] = [];
  if (updated.status === 'rejected') failures.push(updated.reason);
  if (logged.status === 'rejected') failures.push(logged.reason);
  if (failures.length > 1) throw new AggregateError(failures, 'Failed to pause robot and persist credit exhaustion notice');
  if (failures.length) throw failures[0];
  if (logged.status === 'rejected') throw logged.reason;
  return logged.value;
}