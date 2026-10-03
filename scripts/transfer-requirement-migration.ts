/** Operator only. No .env loading, public route, model tool or automatic resume. */
import { createClient } from '@supabase/supabase-js';
import { Sandbox } from '@vercel/sandbox';
import {
  applyMigrationExecutionHandoff, executionHandoffInputSchema, findMigrationExecutionHandoff,
  inspectMigrationExecutionHandoff, type ExecutionHandoffDependencies,
} from '../src/lib/services/apps-platform/migration-execution-handoff';

const usage = `Usage (dry-run by default):
  /opt/homebrew/opt/node@22/bin/node --import tsx /Users/prado/Desktop/Proyectos/Uncodie/Code/API/scripts/transfer-requirement-migration.ts
    --makinari-project=REF --apps-project=REF --requirement=UUID --instance=UUID
    --file=migrations/FILE.sql --request=UUID --operator=ID --reason=TEXT [--apply]

Run from /Users/prado/Desktop/Proyectos/Uncodie/Code/API.
--apply registers pending Apps feedback, then transfers legacy execution authority.
The requirement remains blocked. No SQL is applied or validated; no worker/sandbox is resumed.
Reuse --request and the same arguments after an interrupted call; never change it to force a retry.
Credentials are environment-only; see docs/MIGRATION_EXECUTION_HANDOFF.md.`;

function projectClient(ref: string | undefined, value: string | undefined, key: string | undefined) {
  if (!ref || !/^[a-z]{20}$/.test(ref) || !value || !key) throw new Error('Explicit project credentials required.');
  const url = new URL(value);
  if (url.origin !== `https://${ref}.supabase.co` || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) throw new Error('Project URL mismatch.');
  return createClient(url.href, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { console.log(usage); return; }
  const flags = new Map<string, string>();
  for (const arg of args) {
    const match = /^--(makinari-project|apps-project|requirement|instance|file|request|operator|reason)=(.+)$/.exec(arg);
    const flag = match?.[1] || (arg === '--apply' ? 'apply' : null);
    if (!flag || flags.has(flag)) throw new Error('Unsupported or repeated arguments.');
    flags.set(flag, match?.[2] || 'true');
  }
  const input = executionHandoffInputSchema.parse({ requirementId: flags.get('requirement'),
    instanceId: flags.get('instance'), file: flags.get('file'), requestId: flags.get('request'),
    operatorId: flags.get('operator'), reason: flags.get('reason') });
  if (flags.get('makinari-project') === flags.get('apps-project')) throw new Error('Separate projects required.');
  const makinari = projectClient(flags.get('makinari-project'),
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const apps = projectClient(flags.get('apps-project'),
    process.env.APPS_SUPABASE_URL || process.env.REPOSITORY_SUPABASE_URL,
    process.env.APPS_SUPABASE_SERVICE_KEY || process.env.REPOSITORY_SUPABASE_SERVICE_ROLE_KEY);
  const token = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!token || !teamId || !projectId) throw new Error('Explicit Vercel credentials/project required.');
  const deps: ExecutionHandoffDependencies = { makinari, apps, appsProjectRef: flags.get('apps-project')!,
    readMigration: async (name, file) => {
      const sandbox = await Sandbox.get({ name, token, teamId, projectId, resume: false });
      if (sandbox.status !== 'running') throw new Error('Named sandbox must already be running.');
      // Sandbox methods can implicitly resume on a stopped-session error even with get(resume:false).
      // Pin the current Session instead: a stop during inspection fails closed, never starts a VM.
      const session = sandbox.currentSession();
      const path = `/vercel/sandbox/${file}`;
      const canonical = await session.runCommand('realpath', ['-e', '--', path], { timeoutMs: 10_000 });
      if (canonical.exitCode !== 0 || (await canonical.stdout()).replace(/\n$/, '') !== path) {
        throw new Error('Migration path must be the exact canonical workspace file.');
      }
      // Do not cat SQL through command logs or reconstruct archived SQL. Reject every symlink alias.
      const bytes = await session.readFileToBuffer({ path });
      const recheck = await session.runCommand('realpath', ['-e', '--', path], { timeoutMs: 10_000 });
      if (recheck.exitCode !== 0 || (await recheck.stdout()).replace(/\n$/, '') !== path || !bytes) {
        throw new Error('Migration path changed or file unavailable.');
      }
      return bytes;
    } };

  const mode = flags.has('apply') ? 'apply' : 'dry-run';
  const existing = await findMigrationExecutionHandoff(input, deps);
  if (existing) { console.log(JSON.stringify({ mode, ...existing })); return; }
  const inspection = await inspectMigrationExecutionHandoff(input, deps);
  if (flags.has('apply')) {
    console.log(JSON.stringify({ mode, ...await applyMigrationExecutionHandoff(inspection, deps) }));
  } else {
    console.log(JSON.stringify({ mode, request_id: input.requestId, evidence_verified: true,
      database_admission: 'checked_on_apply', receipt_found: false, feedback_registered: false,
      sql_checksum: inspection.evidence.sql_checksum, specification_checksum: inspection.evidence.specification_checksum,
      transferred: false, resumed: false }));
  }
}

main().catch(() => {
  // Never echo provider bodies, SQL, operator prose, arguments, URLs or credentials.
  console.error('Migration execution handoff failed. Check arguments, credentials, deployed RPCs and scoped idle state; inspect the request receipt before retrying. Use --help for usage.');
  process.exitCode = 1;
});