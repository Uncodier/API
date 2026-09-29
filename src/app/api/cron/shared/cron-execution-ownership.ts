import { supabaseAdmin } from '@/lib/database/supabase-client';
import { boundedFailureDetail } from './cron-ownership-rejection';

/** Carry the original execution identity across durable steps; never refresh it. */
export interface CronExecutionOwnership {
  requirementId: string;
  runId: string | undefined;
  executionGeneration: number;
  /** Evaluation only. Workflows must own an activated slot. */
  allowInactive?: boolean;
  /** Cleanup after completion/blocking; does NOT bypass owner/generation/expiry. */
  allowTerminal?: boolean;
}

export class CronExecutionOwnershipError extends Error {
  constructor(public readonly reason: string, detail?: string) {
    super(`Cron execution ownership rejected (${reason})${detail ? `: ${boundedFailureDetail(detail)}` : ''}`);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'CronExecutionOwnershipError';
  }
}

export function isCronExecutionOwnershipError(error: unknown): boolean {
  return error instanceof CronExecutionOwnershipError ||
    (error instanceof Error && error.name === 'CronExecutionOwnershipError');
}

/**
 * No read-based fallback: an older database cannot safely authorize execution.
 * Apply 20260926070000_harness_execution_ownership.sql before deploying callers.
 */
export async function assertCronExecutionOwnership(
  ownership: CronExecutionOwnership,
): Promise<void> {
  const reject = (reason: string, detail?: string, code?: string): never => {
    const error = new CronExecutionOwnershipError(reason, detail);
    // Log at the source, before durable error wrapping can discard the reason.
    // No RPC response, stack, metadata, or credentials are included.
    console.warn('[CronOwnership] Execution rejected', {
      event: 'cron_execution_ownership_rejected',
      requirementId: boundedFailureDetail(ownership.requirementId, 120),
      runId: boundedFailureDetail(ownership.runId, 120),
      executionGeneration: Number.isSafeInteger(ownership.executionGeneration) ? ownership.executionGeneration : null,
      allowInactive: ownership.allowInactive === true,
      allowTerminal: ownership.allowTerminal === true,
      reason: boundedFailureDetail(reason, 80),
      ...(code ? { code: boundedFailureDetail(code, 80) } : {}),
      ...(detail ? { detail: boundedFailureDetail(detail) } : {}),
    });
    throw error;
  };
  if (!ownership.runId?.trim() || !ownership.requirementId ||
      !Number.isSafeInteger(ownership.executionGeneration) ||
      ownership.executionGeneration < 0) {
    reject('missing_execution_identity');
  }
  let response;
  try {
    response = await supabaseAdmin.rpc('assert_requirement_cron_execution_owner', {
      p_requirement_id: ownership.requirementId,
      p_run_id: ownership.runId,
      p_expected_execution_generation: ownership.executionGeneration,
      p_allow_inactive: ownership.allowInactive === true,
      p_allow_terminal: ownership.allowTerminal === true,
    });
  } catch (error) {
    return reject('ownership_check_unavailable',
      error instanceof Error ? error.message : String(error));
  }
  if (response.error) {
    reject('ownership_check_unavailable',
      `Deploy 20260926070000_harness_execution_ownership.sql first. ` +
      `${response.error.code || ''} ${response.error.message || ''}`, response.error.code);
  }
  if (response.data?.current !== true) {
    const reason = response.data?.reason;
    reject(typeof reason === 'string' && /^[a-z_]{1,80}$/.test(reason)
      ? reason : 'ownership_not_confirmed');
  }
}

/** Check again at actual dispatch, not only before a potentially slow LLM call. */
export function withCronExecutionOwnership<
  T extends { execute?: (...args: any[]) => any },
>(tools: T[], ownership: CronExecutionOwnership, assertCurrent = assertCronExecutionOwnership): T[] {
  return tools.map((tool) => {
    if (typeof tool.execute !== 'function') return tool;
    const execute = tool.execute;
    return {
      ...tool,
      execute: async (...args: any[]) => {
        await assertCurrent(ownership);
        return execute.apply(tool, args);
      },
    };
  });
}