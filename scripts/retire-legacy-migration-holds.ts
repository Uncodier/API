/** Operator-only; environment credentials, no SQL application or archive reactivation. */
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const usage = `Usage (dry-run by default):
  node --import tsx /Users/prado/Desktop/Proyectos/Uncodie/Code/API/scripts/retire-legacy-migration-holds.ts
    --project=REF --all --operator=ID --reason=TEXT [--apply] [--resume]

Retires platform_review/correction_required authority with private receipts.
Never applies or validates SQL, edits Apps receipts, resets product budgets,
unarchives owners, resumes manual pauses, or starts a worker directly.
--resume requires --apply and admits eligible existing owners after retirement.
Requires the Makinari retirement migration and environment-only service credentials.`;

function requestId(requirement: string, file: string, version: number, generation: number): string {
  const hex = createHash('sha256').update(JSON.stringify([
    'migration-retirement-v1', requirement, file, version, generation,
  ])).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { console.log(usage); return; }
  const flags = new Map<string, string>();
  for (const arg of args) {
    const match = /^--(project|operator|reason)=(.+)$/.exec(arg);
    const flag = match?.[1] || (/^--(?:all|apply|resume)$/.test(arg) ? arg.slice(2) : null);
    if (!flag || flags.has(flag)) throw new Error('Unsupported or repeated arguments.');
    flags.set(flag, match?.[2] || 'true');
  }
  const project = flags.get('project');
  const operator = flags.get('operator');
  const reason = flags.get('reason');
  if (!flags.has('all') || !project || !/^[a-z]{20}$/.test(project) || !operator?.trim() ||
      operator.length > 200 || !reason?.trim() || reason.length > 2000 ||
      [operator, reason].some(text => /[\r\n]|\b\w*(?:password|token|secret|api_key)\w*\s*[:=]|https?:\/\//i.test(text)) ||
      (flags.has('resume') && !flags.has('apply'))) throw new Error('Invalid retirement arguments.');
  const raw = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!raw || !key) throw new Error('Explicit Makinari service credentials required.');
  const url = new URL(raw);
  if (url.origin !== `https://${project}.supabase.co` || url.pathname !== '/' ||
      url.username || url.password || url.search || url.hash) throw new Error('Project URL mismatch.');
  const db = createClient(url.href, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const rows = await db.from('requirement_migration_lifecycle')
    .select('requirement_id,file,state,version').in('state', ['platform_review', 'correction_required'])
    .order('requirement_id').order('file');
  if (rows.error || !rows.data) throw new Error('Retirement inventory unavailable.');
  const resumeCandidates = new Map<string, { owner: string; receipts: string[] }>();
  let failed = false;
  for (const row of rows.data) {
    const req = await db.from('requirements').select('id,metadata,status,cron_lock_active,cron_lock_expires_at,site_id,user_id')
      .eq('id', row.requirement_id).single();
    const generation = Number(req.data?.metadata?.requirement_execution_generation ?? 0);
    const owner = req.data?.metadata?.runner_instance_id;
    if (req.error || !req.data || !Number.isInteger(generation) || generation < 0 ||
        typeof owner !== 'string' || !/^[a-f0-9-]{36}$/i.test(owner)) throw new Error('Retirement owner unavailable.');
    const request = requestId(row.requirement_id, row.file, row.version, generation);
    if (!flags.has('apply')) {
      console.log(JSON.stringify({ mode: 'dry-run', requirement_id: row.requirement_id,
        file: row.file, prior_state: row.state, request_id: request, retired: false, resumed: false }));
      continue;
    }
    const result = await db.rpc('retire_requirement_migration_hold', {
      p_requirement_id: row.requirement_id, p_file: row.file, p_expected_version: row.version,
      p_expected_execution_generation: generation, p_instance_id: owner, p_request_id: request,
      p_operator_id: operator, p_reason: reason,
    });
    if (result.error || result.data?.receipt_id !== request || result.data?.state !== 'transferred' || result.data?.resumed !== false) {
      console.log(JSON.stringify({ requirement_id: row.requirement_id, file: row.file,
        request_id: request, retired: false, resumed: false,
        error_code: result.error?.code || 'INVALID_RETIREMENT_RECEIPT' }));
      failed = true;
      continue;
    }
    console.log(JSON.stringify({ requirement_id: row.requirement_id, file: row.file,
      request_id: request, retired: true, resumed: false }));
    const candidate = resumeCandidates.get(row.requirement_id) || { owner, receipts: [] };
    candidate.receipts.push(request);
    resumeCandidates.set(row.requirement_id, candidate);
  }
  // Recover admission candidates after an interrupted process without minting
  // another retirement identity or consuming a new diagnostic allowance.
  if (flags.has('resume')) {
    const saved = await db.from('requirement_migration_retirements')
      .select('id,requirement_id,instance_id').eq('operator_id', operator).eq('reason', reason);
    if (saved.error) throw new Error('Retirement receipt recovery unavailable.');
    for (const receipt of saved.data || []) {
      const candidate: { owner: string; receipts: string[] } = resumeCandidates.get(receipt.requirement_id) || { owner: receipt.instance_id, receipts: [] };
      if (candidate.owner !== receipt.instance_id) throw new Error('Retirement owner changed.');
      if (!candidate.receipts.includes(receipt.id)) candidate.receipts.push(receipt.id);
      resumeCandidates.set(receipt.requirement_id, candidate);
    }
  }
  if (flags.has('resume')) for (const [requirementId, candidate] of resumeCandidates) {
    const [req, owner, history, pauses] = await Promise.all([
      db.from('requirements').select('site_id,user_id,status,metadata').eq('id', requirementId).single(),
      db.from('remote_instances').select('id,site_id,user_id,status,is_archived').eq('id', candidate.owner).single(),
      db.from('requirement_migration_lifecycle').select('state').eq('requirement_id', requirementId),
      db.from('instance_plans').select('id').eq('instance_id', candidate.owner)
        .eq('metadata->>requirement_id', requirementId).eq('status', 'paused'),
    ]);
    const eligible = !req.error && !owner.error && !history.error && !pauses.error &&
      req.data?.status === 'blocked' && !req.data.metadata?.execution_hold &&
      req.data.metadata?.runner_instance_id === candidate.owner &&
      owner.data?.is_archived === false && ['pending', 'running', 'error'].includes(owner.data.status) &&
      owner.data.site_id === req.data.site_id && owner.data.user_id === req.data.user_id &&
      history.data?.every(row => ['validated', 'transferred'].includes(row.state)) && pauses.data?.length === 0;
    if (!eligible) {
      console.log(JSON.stringify({ requirement_id: requirementId, resumed: false,
        reason: 'Owner archive/pause, remaining hold, or unavailable scope prevents admission.' }));
      continue;
    }
    const action = `migration-retirement-resume:${candidate.receipts.sort().join(',')}`;
    const result = await db.rpc('resume_instance_execution_on_user_action', {
      p_requirement_id: requirementId, p_instance_id: candidate.owner, p_reopen_paused_plans: false,
      p_action_id: action, p_allow_terminal_reopen: true,
    });
    if (result.error || !['applied', 'duplicate'].includes(result.data?.state)) {
      console.log(JSON.stringify({ requirement_id: requirementId, resumed: false, error_code: result.error?.code || 'RESUME_DENIED' }));
      failed = true;
      continue;
    }
    // Admission is not evidence that a worker ran. Do not change archive/pause states.
    if (owner.data!.status === 'error') {
      const update = await db.from('remote_instances').update({ status: 'pending' }).eq('id', candidate.owner)
        .eq('site_id', req.data!.site_id).eq('is_archived', false).eq('status', 'error');
      if (update.error) failed = true;
    }
    const audit = await db.from('instance_logs').insert({ instance_id: candidate.owner, site_id: req.data!.site_id,
      log_type: 'system', level: 'info', message: 'Operator admitted normal execution after legacy hold retirement. Worker startup is not confirmed.',
      details: { event: 'migration_retirement_resume', requirement_id: requirementId, action_id: action, receipts: candidate.receipts } });
    if (audit.error) failed = true;
    console.log(JSON.stringify({ requirement_id: requirementId, admitted: true, worker_started: false }));
  }
  if (failed) process.exitCode = 1;
}

main().catch(() => {
  console.error('Legacy retirement failed. Verify the deployed Makinari RPC, scoped idle state and environment credentials; no SQL application is claimed.');
  process.exitCode = 1;
});