/** Operator only. No automatic .env loading, model tool, HTTP route or scheduled task. */
import { createClient } from '@supabase/supabase-js';
import { Sandbox } from '@vercel/sandbox';
import {
  applyMigrationReconciliation, inspectMigrationReconciliation, reconciliationInputSchema,
  resumeMigrationReconciliation, type ReconciliationDependencies,
} from '../src/lib/services/apps-platform/migration-operator-reconciliation';

const usage = `Usage (dry-run by default):
  reconcile-requirement-migration.ts --makinari-project=REF --apps-project=REF
    --requirement=UUID --instance=UUID --plan=UUID --step=ID --file=migrations/FILE.sql
    --request=UUID --operator=ID --reason=TEXT [--apply] [--resume]

--apply records the audited reconciliation, but leaves execution blocked.
--apply --resume additionally admits the existing worker without resetting counters.
Reuse --request after an interrupted call; never invent a new ID to force a retry.
Credentials are environment-only; see docs/MIGRATION_OPERATOR_RECONCILIATION.md.`;

function projectClient(ref: string | undefined, url: string | undefined, key: string | undefined) {
  if (!ref || !/^[a-z]{20}$/.test(ref) || !url || !key ||
      new URL(url).origin !== `https://${ref}.supabase.co` || new URL(url).username || new URL(url).password) {
    throw new Error('Explicit project ref and matching server URL/service key are required.');
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { console.log(usage); return; }
  const flags = new Map<string, string>();
  for (const arg of args) {
    const match = /^--(makinari-project|apps-project|requirement|instance|plan|step|file|request|operator|reason)=(.+)$/.exec(arg);
    const flag = match?.[1] || (['--apply', '--resume'].includes(arg) ? arg.slice(2) : null);
    if (!flag || flags.has(flag)) throw new Error('Unsupported or repeated arguments.');
    flags.set(flag, match?.[2] || 'true');
  }
  if (flags.has('resume') && !flags.has('apply')) throw new Error('--resume requires --apply.');
  const input = reconciliationInputSchema.parse({ requirementId: flags.get('requirement'),
    instanceId: flags.get('instance'), planId: flags.get('plan'), stepId: flags.get('step'),
    file: flags.get('file'), requestId: flags.get('request'), operatorId: flags.get('operator'), reason: flags.get('reason') });
  if (flags.get('makinari-project') === flags.get('apps-project')) throw new Error('Makinari and Apps must be separate projects.');
  const makinari = projectClient(flags.get('makinari-project'),
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const apps = projectClient(flags.get('apps-project'),
    process.env.APPS_SUPABASE_URL || process.env.REPOSITORY_SUPABASE_URL,
    process.env.APPS_SUPABASE_SERVICE_KEY || process.env.REPOSITORY_SUPABASE_SERVICE_ROLE_KEY);
  const token = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!token || !teamId || !projectId) throw new Error('Explicit Vercel sandbox credentials/project required.');
  const deps: ReconciliationDependencies = { makinari, apps, appsProjectRef: flags.get('apps-project')!,
    readMigration: async (name, path) => {
      const sandbox = await Sandbox.get({ name, token, teamId, projectId, resume: false });
      const wasRunning = sandbox.status === 'running';
      try {
        const bytes = await sandbox.readFileToBuffer({ path: `/vercel/sandbox/${path}` });
        if (!bytes) throw new Error('Migration file unavailable.');
        return bytes;
      } finally {
        if (!wasRunning) await sandbox.stop();
      }
    } };

  // An uncertain RPC response must not cause a second operation. Read its durable identity.
  // An observed early rollout had the receipt table but no fresh resume evidence.
  // Refuse that draft before performing even the first reconciliation mutation.
  const { error: versionError } = await makinari.from('requirement_migration_reconciliation_resumes')
    .select('receipt_id,evidence').limit(1);
  if (versionError) throw new Error('Final fresh-evidence migration is not available.');
  const { data: existing, error } = await makinari.from('requirement_migration_reconciliations')
    .select('id,requirement_id,instance_id,plan_id,step_id,file,operator_id,reason')
    .eq('id', input.requestId).maybeSingle();
  if (error) throw new Error('Reconciliation migration is not available.');
  if (existing) {
    if (existing.requirement_id !== input.requirementId || existing.instance_id !== input.instanceId ||
        existing.plan_id !== input.planId || existing.step_id !== input.stepId || existing.file !== input.file ||
        existing.operator_id !== input.operatorId || existing.reason !== input.reason) throw new Error('Request ID belongs to another operation.');
    console.log(JSON.stringify({ mode: flags.has('apply') ? 'apply' : 'dry-run', receipt_id: existing.id,
      already_recorded: true }));
  } else {
    const inspection = await inspectMigrationReconciliation(input, deps);
    console.log(JSON.stringify({ mode: flags.has('apply') ? 'apply' : 'dry-run', requirement_id: input.requirementId,
      request_id: input.requestId, evidence_verified: true, database_admission: 'checked_on_apply', attempts: inspection.prior.attempts,
      old_specification_checksum: inspection.prior.specification_checksum,
      new_specification_checksum: inspection.evidence.specification_checksum, sql_checksum: inspection.prior.checksum,
      receipt_found: false, worker_started: false }));
    if (flags.has('apply')) console.log(JSON.stringify(await applyMigrationReconciliation(inspection, deps)));
  }
  if (flags.has('resume')) console.log(JSON.stringify(await resumeMigrationReconciliation(input.requirementId, input.requestId, deps)));
}

main().catch(() => {
  // Provider bodies, SQL, snapshots, operator prose and credentials must not enter logs.
  console.error('Migration reconciliation failed. Check arguments, credentials, deployment and current scoped state; inspect the request receipt before retrying. Use --help for usage.');
  process.exitCode = 1;
});