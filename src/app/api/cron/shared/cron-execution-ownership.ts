import { supabaseAdmin } from '@/lib/database/supabase-client';

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
    super(`Cron execution ownership rejected (${reason})${detail ? `: ${detail}` : ''}`);
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
  if (!ownership.runId?.trim() || !ownership.requirementId ||
      !Number.isSafeInteger(ownership.executionGeneration) ||
      ownership.executionGeneration < 0) {
    throw new CronExecutionOwnershipError('missing_execution_identity');
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
    throw new CronExecutionOwnershipError('ownership_check_unavailable',
      error instanceof Error ? error.message : String(error));
  }
  if (response.error) {
    throw new CronExecutionOwnershipError('ownership_check_unavailable',
      `Deploy 20260926070000_harness_execution_ownership.sql first. ` +
      `${response.error.code || ''} ${response.error.message || ''}`);
  }
  if (response.data?.current !== true) {
    throw new CronExecutionOwnershipError(response.data?.reason || 'ownership_not_confirmed');
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