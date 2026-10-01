import { supabaseAdmin } from '@/lib/database/supabase-client';
import { createHash } from 'node:crypto';
import { logCronInfrastructureEvent, type CronAuditContext } from '@/lib/services/cron-audit-log';
import {
  ACTION_OBSERVATION_EVENT, makeActionObservation, observableAction,
  parseActionObservation, repeatedActionObservation, type StepActionObservation,
} from './step-action-observation';

export async function loadStepActionObservations(audit: CronAuditContext): Promise<StepActionObservation[]> {
  if (!audit.siteId || !audit.instanceId || !audit.planId || !audit.stepId) return [];
  try {
    const { data, error } = await supabaseAdmin.from('instance_logs').select('details')
      .eq('site_id', audit.siteId).eq('instance_id', audit.instanceId)
      .eq('log_type', 'infrastructure').eq('details->>source', 'cron_infrastructure')
      .eq('details->>event', ACTION_OBSERVATION_EVENT)
      .eq('details->>plan_id', audit.planId).eq('details->>step_id', audit.stepId)
      .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(30);
    if (error) return [];
    const observations = (data || []).map(row => parseActionObservation(row.details?.observation));
    // An unreadable intervening record might have changed the result. Do not
    // join older matching failures across a gap in observation history.
    return observations.some(value => !value) ? [] : observations as StepActionObservation[];
  } catch { return []; }
}

export interface ActionGuardContext {
  observations: StepActionObservation[];
  readFingerprint: () => Promise<string | null | undefined>;
  record: (observation: StepActionObservation) => Promise<void>;
  eventId: string;
  /** Exact content/version of paths read, including ignored files and metadata. */
  readLocalState?: (paths: string[]) => Promise<string | undefined>;
  /** Recheck after asynchronous fingerprint reads, immediately before dispatch. */
  assertCurrent?: () => Promise<void>;
}

/** Never assume a Git file list covers a read. Hash the actual requested file
 * and metadata; missing/oversized/unreadable files leave the read unblocked. */
export async function captureLocalReadState(sandbox: {
  fs: { readFile: (path: string, encoding: 'utf8') => Promise<string>; stat: (path: string) => Promise<any> };
}, paths: string[]): Promise<string | undefined> {
  try {
    const parts = await Promise.all(paths.map(async path => {
      const stat = await sandbox.fs.stat(path);
      if (stat?.isSymbolicLink?.() || stat?.isDirectory?.() ||
          typeof stat?.size !== 'number' || stat.size > 256_000) return undefined;
      const content = await sandbox.fs.readFile(path, 'utf8');
      if (content.length > 256_000) return undefined;
      return [path, stat.size, stat.mode, stat.mtime?.toISOString?.(), content];
    }));
    if (parts.some(part => !part)) return undefined;
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  } catch { return undefined; }
}

export function persistStepActionObservation(audit: CronAuditContext, observation: StepActionObservation): Promise<void> {
  return logCronInfrastructureEvent(audit, {
    event: ACTION_OBSERVATION_EVENT,
    message: `Observed ${observation.tool_name}: ${observation.outcome}; diagnostic comparison only`,
    details: { observation },
  });
}

/** Text from logs is never an executable guard. Missing trusted observations
 * degrades to ordinary execution under the existing ownership/budget policies. */
export function withActionLoopGuard<
  T extends { name?: string; execute?: (args: any) => any },
>(tools: T[], _historyText: string, context?: ActionGuardContext): T[] {
  if (!context) return tools;
  let sequence = 0;
  const fingerprint = async (action: NonNullable<ReturnType<typeof observableAction>>) => {
    try {
      const workspace = await context.readFingerprint();
      if (!workspace) return undefined;
      if (!action.readOnly) return workspace;
      const local = action.paths && await context.readLocalState?.(action.paths);
      return local ? createHash('sha256').update(JSON.stringify([workspace, local])).digest('hex') : undefined;
    } catch { return undefined; }
  };
  return tools.map(tool => {
    if (!tool.name || !tool.execute) return tool;
    const name = tool.name;
    const execute = tool.execute.bind(tool);
    return {
      ...tool,
      execute: async (args: Record<string, unknown>) => {
        const action = observableAction(name, args);
        if (!action) return execute(args);
        const before = await fingerprint(action);
        const repeated = repeatedActionObservation(context.observations, name, args, before);
        await context.assertCurrent?.();
        // A test can depend on time, a database or a recovered server. Its
        // repetition is feedback only, not authority to prevent a valid retest.
        if (repeated && action.readOnly) {
          return {
            success: false, blocked: true, executed: false,
            error: 'unchanged_action_state_result',
            message: 'Three confirmed reads have the same action, current file content and observed state. Recover the saved source result with instance_history, or perform a different targeted check. A file or workspace change permits a fresh read.',
            observation_id: repeated.observation_id,
            previous_result_excerpt: repeated.excerpt,
          };
        }
        const eventId = `${context.eventId}:observation:${sequence++}`;
        const save = async (result: unknown, threw = false) => {
          // Diagnostic telemetry is not a receipt/authorization boundary. A
          // logging failure must not cause an already executed tool to replay.
          try {
            const observation = makeActionObservation({
              eventId, name, args, result, before, after: await fingerprint(action), threw,
            });
            if (!observation) return;
            context.observations.unshift(observation);
            context.observations.splice(30);
            await context.record(observation);
          } catch { /* diagnostic failure is not a tool failure */ }
        };
        try {
          const result = await execute(args);
          await save(result);
          return result;
        } catch (error) {
          await save({ error: error instanceof Error ? error.message : String(error) }, true);
          throw error;
        }
      },
    };
  });
}