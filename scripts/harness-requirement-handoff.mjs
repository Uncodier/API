import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const uuid = value => typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const parse = value => {
  try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; }
};

// Receipt fingerprints, never customer text, arguments, source or credentials.
function receipts(session) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const result = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    for (const call of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
      if (typeof call.id !== 'string' || typeof call.name !== 'string') continue;
      const response = messages.slice(index + 1).find(item => item.role === 'tool' && item.toolCallId === call.id);
      const output = parse(response?.content);
      if (!output || output.ok !== true) continue;
      if (call.name === 'exec' && output.output?.exitCode !== 0) continue;
      if (!['exec', 'write_file', 'apply_patch'].includes(call.name)) continue;
      result.push(digest(`${session.id}:${call.id}:${call.name}`));
    }
  }
  return [...new Set(result)].sort();
}

export function validateScope(scope) {
  if (!scope || !['siteId', 'userId', 'requirementId'].every(key => uuid(scope[key]))) {
    throw new Error('Explicit site, owner and requirement UUIDs are required');
  }
}

/** Injected service observer: SELECT only, exact tenant/owner scope, no cron/RPCs. */
export async function sampleHandoff(client, scope, now = new Date()) {
  validateScope(scope);
  const read = async query => {
    const response = await query;
    if (!response || response.error) throw new Error('Handoff observation unavailable');
    return response.data;
  };
  const requirement = await read(client.from('requirements')
    .select('id,site_id,user_id,type,external_user_action_revision,last_external_user_action_id')
    .eq('id', scope.requirementId).eq('site_id', scope.siteId).eq('user_id', scope.userId).maybeSingle());
  if (!requirement || requirement.id !== scope.requirementId || requirement.site_id !== scope.siteId || requirement.user_id !== scope.userId) {
    throw new Error('Requirement scope unavailable');
  }
  const command = await read(client.from('requirement_commands').select('action_id,revision,created_at,applied_at')
    // Commands inherit tenant scope from the requirement verified above; this
    // table has no site_id column. Never query arbitrary unverified IDs here.
    .eq('requirement_id', requirement.id)
    .order('revision', { ascending: false }).limit(1).maybeSingle());
  const action = command && await read(client.from('instance_logs').select('id,details,created_at,trusted_user_action,log_type')
    .eq('id', command.action_id).eq('site_id', scope.siteId).maybeSingle());
  const mapping = await read(client.from('harness_requirement_runs').select('requirement_id,site_id,session_id')
    .eq('requirement_id', scope.requirementId).eq('site_id', scope.siteId).maybeSingle());
  let session = null;
  if (mapping) {
    if (mapping.requirement_id !== scope.requirementId || mapping.site_id !== scope.siteId || !uuid(mapping.session_id)) {
      throw new Error('Session mapping scope mismatch');
    }
    const row = await read(client.from('harness_sessions').select('id,site_id,user_id,snapshot')
      .eq('id', mapping.session_id).eq('site_id', scope.siteId).eq('user_id', scope.userId).maybeSingle());
    if (row) {
      if (row.id !== mapping.session_id || row.site_id !== scope.siteId || row.user_id !== scope.userId ||
        row.snapshot?.id !== row.id || row.snapshot?.request?.requirementId !== scope.requirementId) {
        throw new Error('Session ownership mismatch');
      }
      session = row.snapshot;
    }
  }
  return { schemaVersion: 1, ...scope, observedAt: now.toISOString(), type: requirement.type,
    revision: requirement.external_user_action_revision, actionId: requirement.last_external_user_action_id,
    command: command ? { revision: command.revision, actionId: command.action_id, appliedAt: command.applied_at } : null,
    actionCompleted: !!action && action.id === command.action_id && action.log_type === 'user_action' &&
      action.trusted_user_action === true && action.details?.status === 'completed',
    sessionId: session?.id ?? null, sessionUpdatedAt: session?.updatedAt ?? null,
    receiptFingerprints: receipts(session) };
}

/** Handoff liveness only. Even passed cannot establish source/functional delivery. */
export function evaluateHandoff(baseline, current, deadlineSeconds = 300) {
  const check = (name, passed) => ({ name, passed: passed === true });
  const scoped = baseline?.schemaVersion === 1 && current?.schemaVersion === 1 &&
    ['siteId', 'userId', 'requirementId'].every(key => uuid(baseline[key]) && baseline[key] === current[key]);
  const start = time(baseline?.observedAt), end = time(current?.observedAt);
  const validDeadline = Number.isSafeInteger(deadlineSeconds) && deadlineSeconds > 0 && deadlineSeconds <= 1800;
  const elapsed = start !== null && end !== null ? end - start : null;
  const old = new Set(Array.isArray(baseline?.receiptFingerprints) ? baseline.receiptFingerprints : []);
  const fresh = Array.isArray(current?.receiptFingerprints) ? current.receiptFingerprints.filter(value =>
    typeof value === 'string' && /^[a-f\d]{64}$/.test(value) && !old.has(value)) : [];
  const applied = time(current?.command?.appliedAt), updated = time(current?.sessionUpdatedAt);
  const checks = [check('same_authorized_requirement', scoped),
    check('same_requirement_type', typeof baseline?.type === 'string' && baseline.type === current?.type),
    check('new_user_command', Number.isSafeInteger(baseline?.revision) && Number.isSafeInteger(current?.revision) &&
      current.revision > baseline.revision && current.command?.revision === current.revision &&
      uuid(current.actionId) && current.command.actionId === current.actionId && applied !== null && start !== null && applied >= start),
    check('submitting_action_completed', current?.actionCompleted === true),
    check('session_after_command', uuid(current?.sessionId) && updated !== null && applied !== null && updated >= applied),
    check('fresh_successful_workspace_receipt', fresh.length > 0),
    check('within_deadline', validDeadline && elapsed !== null && elapsed >= 0 && elapsed <= deadlineSeconds * 1000)];
  const passed = checks.every(item => item.passed);
  return { suite: 'requirement-handoff-liveness', state: passed ? 'passed' :
    validDeadline && elapsed !== null && elapsed >= deadlineSeconds * 1000 ? 'timed_out' : 'pending',
    passed, healthGreen: false, deliveryVerified: false, checks,
    note: 'Workspace execution is not delivery. Independently verify changed source and acceptance behavior.' };
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const [mode, file, acknowledgement] = args;
  if (!['baseline', 'check'].includes(mode) || !file || args.length !== 3 || acknowledgement !== '--ack-private-read-only') {
    throw new Error('Usage: baseline|check /absolute/private/baseline.json --ack-private-read-only');
  }
  if (!file.startsWith('/')) throw new Error('Use an absolute private baseline path');
  const scope = { siteId: env.HARNESS_E2E_SITE_ID, userId: env.HARNESS_E2E_USER_ID, requirementId: env.HARNESS_E2E_REQUIREMENT_ID };
  validateScope(scope);
  const url = new URL(env.NEXT_PUBLIC_SUPABASE_URL);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    url.hostname !== `${env.HARNESS_E2E_PROJECT_REF}.supabase.co` || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Observer configuration unavailable');
  const client = createClient(url.origin, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const current = await sampleHandoff(client, scope);
  if (mode === 'baseline') {
    writeFileSync(file, JSON.stringify(current) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ state: 'baseline_saved', healthGreen: false }));
    return 0;
  }
  const report = evaluateHandoff(JSON.parse(readFileSync(file, 'utf8')), current,
    env.HARNESS_E2E_DEADLINE_SECONDS === undefined ? 300 : Number(env.HARNESS_E2E_DEADLINE_SECONDS));
  console.log(JSON.stringify(report, null, 2));
  return report.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }).catch(() => {
    console.error('Private handoff observer unavailable; no work dispatched.'); process.exitCode = 2;
  });
}