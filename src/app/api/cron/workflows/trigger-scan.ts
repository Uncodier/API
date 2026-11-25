import { randomUUID } from 'node:crypto';
import { start } from 'workflow/api';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { materializeRunFromGraph } from '@/lib/services/workflow-robot/materialize';
import { isCronDueInWindow, WORKFLOW_CRON_WINDOW_MS } from '@/lib/services/workflow-robot/cron-window';
import { DEFAULT_TIMEZONE, normalizeTimezone } from '@/lib/timezone';
import { prepareScheduledConnector } from './connector-admission';
import { deadline, waitFor } from './cron-control';
import { executeScheduledWorkflow } from './workflow';

type Trigger = { id: string; instance_id: string; config: { cron?: string; timezone?: string } | null; site_id: string | null };
const PAGE = 50;
const CONCURRENCY = 8;

// Same site-owner profile resolution as resolveClientTimezone, but cancellable
// and without writing raw database errors into cron logs. A transient lookup
// error is not evidence that a different timezone should be used for admission.
async function siteTimezone(site: string, signal: AbortSignal) {
  const owner = await supabaseAdmin.from('sites').select('user_id').eq('id', site)
    .abortSignal(deadline(signal, 5000)).maybeSingle();
  if (owner.error) throw new Error('Timezone lookup unavailable.');
  if (!owner.data?.user_id) return DEFAULT_TIMEZONE;
  const profile = await supabaseAdmin.from('profiles').select('timezone').eq('id', owner.data.user_id)
    .abortSignal(deadline(signal, 5000)).maybeSingle();
  if (profile.error) throw new Error('Timezone lookup unavailable.');
  return normalizeTimezone(profile.data?.timezone);
}

async function visit(trigger: Trigger, timezones: Map<string, Promise<string>>, signal: AbortSignal) {
  const cfg = trigger.config;
  if (!cfg?.cron) return 'missing_cron';
  let tz = normalizeTimezone(cfg.timezone);
  if (!cfg.timezone && trigger.site_id) {
    const site = trigger.site_id;
    if (!timezones.has(site)) timezones.set(site, siteTimezone(site, signal));
    tz = await timezones.get(site)!;
  }
  const check = isCronDueInWindow(cfg.cron, Date.now(), WORKFLOW_CRON_WINDOW_MS, tz);
  if (!check.due) return 'not_due';
  const connector = await prepareScheduledConnector(trigger.instance_id, trigger.id, `${check.windowKey}:00Z`, signal);
  if (connector.kind !== 'legacy') return connector.kind;
  const materialized = await waitFor(signal, () => materializeRunFromGraph({
    instance_id: trigger.instance_id,
    trigger_id: trigger.id,
    trigger_payload: { kind: 'cron', cron: cfg.cron, fired_at: new Date().toISOString() },
    idempotency_key: `cron:${trigger.id}:${check.windowKey}`,
  }));
  if (!materialized.steps.length && !materialized.resume_existing_run) return 'duplicate';
  await waitFor(signal, () => start(executeScheduledWorkflow, [materialized.run_plan_id]));
  return 'started';
}

export async function scanTriggers(signal: AbortSignal) {
  const counts = { started: 0, reserved: 0, duplicate: 0, not_due: 0, missing_cron: 0, blocked: 0, connector_disabled: 0, failed: 0 };
  // Rotate the first UUID on cold and warm ticks alike, so a slow prefix is
  // not always served first. The two non-overlapping ranges cover the table.
  const pivot = randomUUID();
  try {
    for (const wrapped of [false, true]) {
      let after: string | undefined;
      for (;;) {
        signal.throwIfAborted();
        let query = supabaseAdmin.from('workflow_triggers').select('id, instance_id, config, site_id')
          .eq('kind', 'cron').eq('enabled', true).order('id', { ascending: true }).limit(PAGE);
        query = wrapped ? query.lt('id', pivot) : query.gte('id', pivot);
        if (after) query = query.gt('id', after);
        const { data, error } = await query.abortSignal(deadline(signal, 6000));
        if (error || !Array.isArray(data)) throw new Error();
        if (!data.length) break;
        const last: string = data[data.length - 1].id;
        if (!last || (after && last <= after)) throw new Error();
        after = last;
        const timezones = new Map<string, Promise<string>>();
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, data.length) }, async () => {
          while (next < data.length && !signal.aborted) {
            const row = data[next++];
            try { counts[await visit(row, timezones, signal)]++; }
            catch { counts.failed++; }
          }
        }));
        // Only an empty page proves exhaustion (the server may cap page size).
      }
    }
    return { complete: true, counts };
  } catch { return { complete: false, counts }; }
}
