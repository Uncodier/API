import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { connect, identity, marker, hash, seedBranch, readFiles, submit, github } from './host.mjs';
import { initialFiles, cases } from './cases.mjs';
import { verifyFiles } from './oracle.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const checked = response => { if (response.error || response.data == null) throw new Error('Scoped database operation unavailable'); return response.data; };
export function options(args) {
  const [mode, id, acknowledgement, caseFlag, selectedCase] = args;
  if (!['preflight', 'run', 'observe', 'stop'].includes(mode) || !/^[a-z0-9-]{8,80}$/.test(id || '') ||
    acknowledgement !== '--ack-live-test' || ![3,5].includes(args.length) ||
    (args.length === 5 && (mode !== 'run' || caseFlag !== '--case' || !['landing-polish','quantity-subtotal','category-filter'].includes(selectedCase)))) throw new Error('Usage: preflight|run|observe|stop RUN_ID --ack-live-test [--case CASE]');
  return { mode, id, ...(selectedCase ? { selectedCase } : {}) };
}
export function withinBudget(run, spec, now, used) {
  if (!Number.isFinite(used) || used < 0 || used >= run.maxCredits) return false;
  if (now - Date.parse(run.startedAt) > run.totalDeadlineMs) return false;
  return spec.executionObservedAt
    ? now - Date.parse(spec.executionObservedAt) <= run.executionDeadlineMs
    : now - Date.parse(spec.startedAt) <= run.admissionDeadlineMs;
}
function location(id) { return `/Users/prado/Desktop/Proyectos/Uncodie/Code/market-fit/agent-test-reports/harness/${id}`; }
function save(run, report) {
  const dir = location(run.id); mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(`${dir}/live-run.json`, JSON.stringify(run, null, 2), { mode: 0o600 });
  writeFileSync(`${dir}/live-report.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
}
async function credits(host, since) {
  const rows = checked(await host.client.from('credit_transactions').select('amount').eq('site_id', host.settings.siteId)
    .gte('created_at', since).limit(1000));
  if (rows.length === 1000 || rows.some(row => !Number.isFinite(row.amount))) throw new Error('Credit observation incomplete');
  return rows.reduce((sum, row) => sum + Math.max(0, -row.amount), 0);
}
async function seed(host, run, spec) {
  spec.requirementId = identity(run.id, spec.id); spec.instanceId = identity(run.id, `${spec.id}:instance`);
  spec.branch = `feature/req-${spec.requirementId}`;
  spec.fixtureRoot = `.harness-live/${run.id}`;
  // An existing isolated application branch, not the repository-wide main tree.
  spec.baselineCommit = await seedBranch(host, spec.branch, spec.fixtureRoot, initialFiles);
  const tag = { marker, run_id: run.id, case_id: spec.id };
  checked(await host.client.from('remote_instances').insert({ id: spec.instanceId, name: `live-harness-${run.id}-${spec.id}`,
    instance_type: 'browser', status: 'pending', site_id: run.siteId, user_id: run.userId, created_by: run.userId,
    metadata: { harness_e2e: tag } }).select('id').single());
  checked(await host.client.from('requirements').insert({ id: spec.requirementId, site_id: run.siteId, user_id: run.userId,
    title: `[Live harness] ${spec.id}`, description: `Existing isolated Cedar app fixture for ${spec.id}`,
    instructions: `Existing app source is under ${spec.fixtureRoot}. Preserve the app and its original exports and assets. Await the authorized user change.`,
    type: 'develop', priority: 'low', status: 'validated', completion_status: 'pending', budget: 0.5, cron: null,
    metadata: { harness_e2e: tag, runner_instance_id: spec.instanceId,
      git: { kind: 'custom', org: 'makinary', repo: 'apps', default_branch: spec.branch } }, backlog: { items: [] } }).select('id').single());
  spec.message = `Update the EXISTING requirement ${spec.requirementId}, not a new requirement. Use requirements update to append the following authorized change to its instructions and set status=backlog. The requirement's existing runner executes it through the normal cron, not this conversation. Do not execute edits in this interactive turn.\n${spec.request}\nWork only in ${spec.fixtureRoot}/ on the existing branch ${spec.branch}. Preserve every file outside that directory. No deployment, no dependency installation, no services, no contacting third parties, no payments. Do not create or replace a plan or requirement. Use the available tools to inspect and modify the existing app, verify the result, and finish_task honestly when complete.`;
  spec.requestHash = hash(spec.message);
  spec.seeded = true;
}

async function observe(host, run, spec) {
  const req = checked(await host.client.from('requirements').select('id,site_id,user_id,type,status,metadata,external_user_action_revision,last_external_user_action_id')
    .eq('id', spec.requirementId).eq('site_id', run.siteId).eq('user_id', run.userId).single());
  if (req.metadata?.harness_e2e?.marker !== marker || req.metadata.harness_e2e.run_id !== run.id ||
    req.metadata.harness_e2e.case_id !== spec.id || req.metadata.runner_instance_id !== spec.instanceId || req.type !== 'develop') throw new Error('Fixture identity changed');
  const command = (await host.observer.from('requirement_commands').select('action_id,revision,applied_at')
    .eq('requirement_id', req.id).order('revision', { ascending: false }).limit(1).maybeSingle());
  if (command.error) throw new Error('Command evidence unavailable');
  let action = null;
  if (spec.actionId) {
    action = checked(await host.observer.from('instance_logs').select('id,details,trusted_user_action,log_type')
      .eq('id', spec.actionId).eq('instance_id', spec.instanceId).eq('site_id', run.siteId).single());
  }
  const mapping = await host.observer.from('harness_requirement_runs').select('session_id,generation,last_cycle_id,next_run_at,pause_reason')
    .eq('requirement_id', spec.requirementId).eq('site_id', run.siteId).maybeSingle();
  if (mapping.error) throw new Error('Mapping evidence unavailable');
  let snapshot = null;
  if (mapping.data) {
    const observed = await host.observer.from('harness_sessions').select('id,site_id,user_id,snapshot')
      .eq('id', mapping.data.session_id).eq('site_id', run.siteId).eq('user_id', run.userId).maybeSingle();
    if (observed.error) throw new Error('Session observation unavailable');
    const row = observed.data;
    // Admission can fail before session creation. A mapping alone is not a
    // session, nor permission to abort polling as an observer implementation bug.
    if (row) {
      snapshot = row.snapshot;
      if (snapshot.id !== row.id || snapshot.request?.requirementId !== spec.requirementId || snapshot.request.repository?.url !== 'https://github.com/makinary/apps.git' || snapshot.request.repository.ref !== spec.branch) throw new Error('Session evidence mismatch');
      if (spec.sessionId && spec.sessionId !== row.id) throw new Error('Session replaced during run');
      spec.sessionId = row.id;
    }
  }
  const calls = (snapshot?.messages || []).flatMap(message => message.toolCalls || []);
  const received = (snapshot?.messages || []).filter(message => message.role === 'tool');
  const matched = calls.filter(call => received.some(message => {
    if (message.toolCallId !== call.id) return false;
    try { return JSON.parse(message.content).ok === true; } catch { return false; }
  }));
  const terminal = snapshot?.status === 'completed' && ['on-review', 'done'].includes(req.status);
  let verification = null;
  // Independently read actual provider files while workspace remains live. No VM resume.
  let files = snapshot && await readFiles(host, snapshot, spec.fixtureRoot, Object.keys(initialFiles));
  let gitScopeVerified = false;
  // Durable terminal source checkpoint is an independent alternative when the
  // provider suspended its VM. Pin a verified branch tip, never use cached reads.
  if (terminal) {
    const tip = await github(host, `git/ref/heads/${spec.branch}`);
    const comparison = await github(host, `compare/${spec.baselineCommit}...${tip.object.sha}`);
    gitScopeVerified = ['ahead', 'identical'].includes(comparison.status) && Array.isArray(comparison.files) && comparison.files.length < 300 &&
      comparison.files.every(file => spec.allowedPaths.includes(file.filename) && (!file.previous_filename || spec.allowedPaths.includes(file.previous_filename)));
    const committed = {};
    for (const name of Object.keys(initialFiles)) {
      const file = await github(host, `contents/${spec.fixtureRoot}/${name}?ref=${tip.object.sha}`);
      if (file.encoding !== 'base64' || file.size > 65536) throw new Error('Independent source checkpoint unavailable');
      committed[name] = Buffer.from(file.content, 'base64').toString('utf8');
    }
    files = committed; spec.finalCommit = tip.object.sha;
  }
  if (files) {
    verification = await verifyFiles(spec.id, files);
    spec.latestSourceHashes = Object.fromEntries(Object.entries(files).map(([name, content]) => [name, hash(content)]));
  }
  const correlated = action?.trusted_user_action === true && action.log_type === 'user_action' && action.details?.status === 'completed' &&
    command.data?.action_id === spec.actionId && !!command.data.applied_at && command.data.revision === req.external_user_action_revision &&
    req.last_external_user_action_id === spec.actionId;
  const sourceChanged = !!files && Object.entries(files).some(([name, content]) => content !== initialFiles[name]);
  const passed = correlated && terminal && gitScopeVerified && matched.some(call => ['exec', 'apply_patch'].includes(call.name)) && sourceChanged && verification?.passed === true;
  return { id: spec.id, state: passed ? 'passed' : ['paused', 'failed', 'cancelled'].includes(snapshot?.status) || req.status === 'blocked' ? 'failed' : 'pending',
    passed, commandApplied: !!command.data?.applied_at, actionCompleted: action?.details?.status === 'completed',
    requirementStatus: req.status, sessionStatus: snapshot?.status ?? null, turns: snapshot?.turns ?? 0,
    tools: [...new Set(matched.map(call => call.name).filter(name => ['exec','apply_patch','list_files','read_files','search','finish_task','requirement_context','requirement_progress','source_archive'].includes(name)))], successfulReceipts: matched.length,
    sourceChanged, gitScopeVerified, verification, sessionId: spec.sessionId ?? null,
    cycleId: mapping.data?.last_cycle_id ?? null, pauseObserved: !!mapping.data?.pause_reason };
}

async function stop(host, run) {
  for (const spec of run.cases.filter(item => item.seeded)) {
    const row = checked(await host.client.from('requirements').select('id,metadata,status').eq('id', spec.requirementId)
      .eq('site_id', run.siteId).eq('user_id', run.userId).single());
    if (row.metadata?.harness_e2e?.marker !== marker || row.metadata.harness_e2e.run_id !== run.id) throw new Error('Cleanup scope mismatch');
    if (['done', 'on-review'].includes(row.status)) continue;
    checked(await host.client.from('requirements').update({ status: 'blocked' }).eq('id', spec.requirementId)
      .eq('site_id', run.siteId).eq('user_id', run.userId).eq('metadata->harness_e2e->>run_id', run.id).select('id').single());
  }
}

export async function main(args = process.argv.slice(2)) {
  const opts = options(args); const host = await connect();
  if (opts.mode === 'stop') {
    const run = JSON.parse(readFileSync(`${location(opts.id)}/live-run.json`, 'utf8'));
    if (run.marker !== marker || run.siteId !== host.settings.siteId || run.userId !== host.userId) throw new Error('Run scope changed');
    await stop(host, run); console.log(JSON.stringify({ state: 'requirement_admission_blocked', activeOperationsStopped: false })); return 0;
  }
  const { probeSandboxAccess } = (await import('/Users/prado/Desktop/Proyectos/Uncodie/Code/market-fit/scripts/harness-e2e/provider-preflight.cjs')).default;
  if (!(await probeSandboxAccess(host.settings)).ready) throw new Error('Real sandbox read preflight failed');
  const funding = checked(await host.client.from('billing').select('credits_available').eq('site_id', host.settings.siteId).single());
  if (funding.credits_available < 12) throw new Error('Dedicated test account requires 12 available credits');
  if (opts.mode === 'preflight') { console.log(JSON.stringify({ state: 'ready', siteId: host.settings.siteId,
    deploymentId: host.deploymentId, deployedSha: host.deployedSha, maxCredits: 12, realProviders: true })); return 0; }
  if (opts.mode !== 'run') {
    const run = JSON.parse(readFileSync(`${location(opts.id)}/live-run.json`, 'utf8'));
    if (run.marker !== marker || run.siteId !== host.settings.siteId || run.userId !== host.userId) throw new Error('Run scope changed');
    if (opts.mode === 'stop') { await stop(host, run); console.log(JSON.stringify({ state: 'stopped' })); return 0; }
    const results = []; for (const spec of run.cases.filter(item => item.seeded)) results.push(await observe(host, run, spec));
    const report = { realProviders: true, results, passed: results.length === run.cases.length && results.every(row => row.passed), fullThreeCaseSuite: run.cases.length === 3 }; save(run, report); console.log(JSON.stringify(report)); return report.passed ? 0 : 1;
  }
  const run = { id: opts.id, marker, siteId: host.settings.siteId, userId: host.userId, startedAt: new Date().toISOString(),
    deploymentId: host.deploymentId, deployedSha: host.deployedSha, maxCredits: 12, cases: cases(opts.id).filter(spec => !opts.selectedCase || spec.id === opts.selectedCase),
    admissionDeadlineMs: 1200000, executionDeadlineMs: 600000, totalDeadlineMs: 2700000 };
  const dir = location(run.id); mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(`${dir}/.live-lock`, `${process.pid}`, { flag: 'wx', mode: 0o600 });
  const report = { realProviders: true, passed: false, fullThreeCaseSuite: run.cases.length === 3, results: [], creditsUsed: 0, state: 'running' };
  save(run, report);
  try {
    for (const spec of run.cases) {
      const baseline = await verifyFiles(spec.id, initialFiles);
      if (baseline.passed || !['isolated-module-execution','browser-runtime','preserved-catalog','preserved-copy-links'].every(id => baseline.checks.some(check => check.id === id && check.passed))) throw new Error('Independent baseline verifier unavailable or defect absent');
      spec.baselineVerification = baseline; save(run, report);
      await seed(host, run, spec); save(run, report);
      spec.startedAt = new Date().toISOString();
      const controller = new AbortController();
      const intake = submit(host, spec, run, controller.signal); // Poll cost while the real assistant turn is running.
      let done = false, intakeError = null;
      intake.then(() => { done = true; }, error => { intakeError = error; done = true; });
      while (!done) {
        await sleep(10000); report.creditsUsed = await credits(host, run.startedAt); save(run, report);
        if (report.creditsUsed >= run.maxCredits || Date.now() - Date.parse(run.startedAt) > run.totalDeadlineMs) {
          controller.abort(); await intake.catch(() => {}); throw new Error('Live suite budget/time reached');
        }
      }
      if (intakeError) throw intakeError;
      save(run, report);
      let result;
      while (true) {
        result = await observe(host, run, spec);
        if (result.sessionId && !spec.executionObservedAt) spec.executionObservedAt = new Date().toISOString();
        report.results = [...report.results.filter(row => row.id !== spec.id), result];
        report.creditsUsed = await credits(host, run.startedAt); save(run, report);
        console.log(JSON.stringify({ case: spec.id, state: result.state, sessionStatus: result.sessionStatus,
          turns: result.turns, sourceChanged: result.sourceChanged, creditsUsed: report.creditsUsed }));
        if (!withinBudget(run, spec, Date.now(), report.creditsUsed)) throw new Error('Live case execution deadline/cost exceeded');
        if (result.passed) break;
        if (result.state === 'failed') throw new Error('Live case failed; inspect safe evidence');
        await sleep(15000);
      }
    }
    report.passed = report.results.length === run.cases.length && report.results.every(row => row.passed); report.state = 'finished';
    save(run, report); return report.passed ? 0 : 1;
  } catch (error) {
    report.state = 'failed'; report.passed = false;
    const codes = new Map([
      ['Command evidence unavailable', 'command_observation_unavailable'],
      ['Session evidence mismatch', 'session_binding_mismatch'],
      ['Live case execution deadline/cost exceeded', 'deadline_or_cost_exceeded'],
      ['Live suite budget/time reached', 'deadline_or_cost_exceeded'],
      ['Live case failed; inspect safe evidence', 'agent_execution_failed'],
      ['Assistant turn did not complete; request will not be replayed', 'intake_incomplete'],
      ['Independent baseline verifier unavailable or defect absent', 'baseline_unavailable'],
    ]);
    report.failureCode = codes.get(error?.message) || 'live_boundary_unavailable';
    try { await stop(host, run); report.requirementAdmissionBlocked = true; } catch { report.requirementAdmissionBlocked = false; }
    report.activeOperationsStopped = false;
    save(run, report); console.error('Live suite failed; inspect private safe report. No request replay.'); return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }).catch(() => { console.error('Live preflight/setup failed; raw credentials and errors suppressed.'); process.exitCode = 2; });
}