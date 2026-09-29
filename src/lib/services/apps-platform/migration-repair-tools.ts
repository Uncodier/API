import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { getAppsAdminClient } from '@/lib/database/apps-supabase';
import { lintMigration } from './migration-linter';
import { splitSqlStatements } from './migration-sql-text';
import { canAutomaticallyReplaceMigration, sanitizeMigrationRepairContext } from './migration-repair-policy';
import type { MigrationRepairTarget } from './migration-repair-types';
import type { MigrationSecurityReview } from './migration-security-review';
import type { Sandbox } from '@vercel/sandbox';

const ROOT = '/vercel/sandbox';
const MAX_SQL_BYTES = 64 * 1024;
const checksum = (sql: string) => createHash('sha256').update(sql).digest('hex');

/** No shell, arbitrary writes, ledger mutation, push, or direct SQL tool is exposed. */
export function createMigrationRepairTools(params: {
  sandbox: Sandbox;
  requirementId: string;
  target: MigrationRepairTarget;
  assertCurrent: () => Promise<void>;
  contextPaths?: string[];
  reviewSecurity: (context: {
    originalSql: string;
    proposedSql?: string;
    specification: string;
    sourceContext: Array<{ path: string; content: string }>;
  }) => Promise<MigrationSecurityReview>;
}) {
  const { sandbox, target, assertCurrent } = params;
  let changed = false;
  let repairedTarget: MigrationRepairTarget | undefined;
  let securityReview: MigrationSecurityReview | undefined;
  let reviewStarted = false;
  let replacing = false;
  let failure: unknown;
  let writeAttempted = false;
  let reviewedSpecification: { path: string; checksum: string } | undefined;
  const sourceContext = new Map<string, string>();
  const contextPaths = new Set(params.contextPaths || []);
  const reviewedSources = new Map<string, string>();
  const validTarget = /^(?:migrations|supabase\/migrations|src\/db\/migrations)\/[A-Za-z0-9_./-]+\.sql$/.test(target.file) &&
    !target.file.split('/').some(part => part === '..' || part === '.') &&
    /^app_[a-f0-9]{24}$/.test(target.schema) && /^[a-f0-9]{64}$/.test(target.checksum);

  async function safePath(path: string): Promise<string> {
    const relative = path.startsWith(`${ROOT}/`) ? path.slice(ROOT.length + 1) : path;
    if (!relative || relative.startsWith('/') || relative.split('/').some(part => !part || part.startsWith('.')) ||
        posix.normalize(relative) !== relative || !/^[A-Za-z0-9_./[\]-]+$/.test(relative)) {
      throw new Error('Only canonical project source paths may be read.');
    }
    const allowed = relative === target.file || relative === 'requirement.spec.md' ||
      /^(?:src|docs|tests)\/.*\.(?:ts|tsx|md|sql)$/.test(relative);
    if (!allowed) throw new Error('Read limited to migration, specification, and project source; secrets are excluded.');
    if (/(?:^|\/)(?:env|secrets?|credentials?)(?:[./_-]|$)/i.test(relative)) {
      throw new Error('Environment and credential sources are excluded from repair context.');
    }
    const absolute = `${ROOT}/${relative}`;
    const resolved = await sandbox.runCommand('realpath', ['--', absolute]);
    if (resolved.exitCode !== 0 || (await resolved.stdout()).trim() !== absolute) {
      throw new Error('Missing file or symlink: migration repair requires a canonical file.');
    }
    return absolute;
  }

  async function verifyPendingTarget(): Promise<{ path: string; current: string }> {
    await assertCurrent();
    if (!validTarget) throw new Error('Invalid migration repair target.');
    const client = getAppsAdminClient();
    const { data: tenant, error: tenantError } = await client.from('apps_tenants')
      .select('tenant_id, schema').eq('requirement_id', params.requirementId).maybeSingle();
    if (tenantError || tenant?.schema !== target.schema || tenant?.tenant_id !== target.tenantId) {
      throw new Error('Migration repair tenant identity could not be confirmed.');
    }
    const { data: receipt, error } = await client.rpc('apps_get_migration_receipt', {
      p_target_schema: target.schema, p_expected_tenant_id: target.tenantId,
      p_migration_key: `migration:${target.file}`,
    });
    if (error || receipt?.found !== false) {
      throw new Error('Migration is applied or its ledger is unavailable; automatic replacement refused.');
    }
    const { data: eligibility, error: eligibilityError } = await client.rpc('apps_check_pending_migration_repair', {
      p_target_schema: target.schema, p_expected_tenant_id: target.tenantId,
      p_migration_key: `migration:${target.file}`, p_migration_checksum: target.checksum,
    });
    if (eligibilityError || eligibility?.repairable !== true) {
      throw new Error('Pending migration repair eligibility is unavailable or this SQL was already applied under another path.');
    }
    const path = await safePath(target.file);
    const current = await sandbox.fs.readFile(path, 'utf8');
    if (checksum(current) !== target.checksum) {
      throw new Error('Migration changed concurrently; revalidate before repairing.');
    }
    return { path, current };
  }

  async function review(originalSql: string, proposedSql?: string): Promise<MigrationSecurityReview> {
    // One independent review per durable repair turn, including concurrent tool calls.
    if (reviewStarted) throw new Error('Security review budget used for this repair turn.');
    reviewStarted = true;
    let specification = '';
    try {
      const path = await safePath('requirement.spec.md');
      specification = await sandbox.fs.readFile(path, 'utf8');
      reviewedSpecification = { path, checksum: checksum(specification) };
    } catch {
      // Missing context cannot authorize a write or manufacture a customer decision.
    }
    if (!specification.trim() || Buffer.byteLength(specification) > MAX_SQL_BYTES) {
      securityReview = { decision: 'platform_review', reason: 'A complete requirement specification is required for security review.' };
    } else {
      if (contextPaths.size > 12) throw new Error('Migration review source context limit exceeded.');
      for (const source of Array.from(contextPaths)) {
        const path = await safePath(source);
        if (path === `${ROOT}/${target.file}` || path === `${ROOT}/requirement.spec.md`) continue;
        const content = await sandbox.fs.readFile(path, 'utf8');
        if (Buffer.byteLength(content) > MAX_SQL_BYTES) throw new Error('Complete source context is too large for migration review.');
        sourceContext.set(path, content);
        reviewedSources.set(path, checksum(content));
      }
      securityReview = await params.reviewSecurity({
        originalSql, proposedSql, specification,
        sourceContext: Array.from(sourceContext, ([path, content]) => ({ path, content })),
      });
    }
    return securityReview;
  }

  const tools = [{
    name: 'migration_read_context',
    description: 'Read the failed migration, requirement.spec.md, or a known src/docs/tests source file. Environment files and symlinks are excluded.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    execute: async (args: { path: string }) => {
      await assertCurrent();
      const path = await safePath(args.path);
      const content = await sandbox.fs.readFile(path, 'utf8');
      contextPaths.add(path);
      return { success: true, path, content: sanitizeMigrationRepairContext(content).slice(0, MAX_SQL_BYTES), truncated: content.length > MAX_SQL_BYTES };
    },
  }, {
    name: 'migration_replace_pending_sql',
    description: 'Propose replacement of ONLY the named failed, unapplied migration. An independent security reviewer must approve it, and all deterministic tenant, ledger, checksum and lint checks must pass. Application is separate.',
    parameters: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
    execute: async (args: { sql: string }) => {
      if (replacing) return { success: false, error: 'A migration replacement is already being evaluated.' };
      replacing = true;
      try {
        await assertCurrent();
        if (!validTarget || changed) return { success: false, error: 'Invalid or already replaced repair target.' };
        if (typeof args.sql !== 'string' || Buffer.byteLength(args.sql) > MAX_SQL_BYTES ||
            splitSqlStatements(args.sql).length === 0) {
          return { success: false, error: 'Provide a nonempty SQL migration within 64 KiB; do not delete or skip the migration.' };
        }
        const statements = splitSqlStatements(args.sql);
        if (!statements.some(stmt => /\b(?:create|alter|insert|update)\b/i.test(stmt.code)) ||
            statements.some(stmt => /\b(?:truncate|delete\s+from|drop\s+(?:table|column))\b/i.test(stmt.code))) {
          return { success: false, error: 'Automatic repair cannot skip the migration or remove tables, columns or data. Request operator review for destructive changes.' };
        }
        const lint = lintMigration({ sql: args.sql, schema: target.schema, tenant_id: target.tenantId });
        if (!lint.ok) return { success: false, error: 'Migration still fails linting.', issues: lint.errors };
        const { current } = await verifyPendingTarget();
        if (checksum(args.sql) === target.checksum) return { success: false, error: 'SQL is unchanged; repair the reported defect.' };
        if (!canAutomaticallyReplaceMigration(current, args.sql)) {
          return { success: false, error: 'Automatic repair must preserve non-policy SQL and existing policy identities. Structural changes, dynamic SQL rewrites, data backfills and policy removal require operator review.' };
        }
        const verdict = await review(current, args.sql);
        if (verdict.decision !== 'approved_for_validation') {
          return { success: false, error: 'Security review did not approve this proposal.', review: verdict };
        }
        // Review is an asynchronous trust boundary: recheck ledger, file and ownership.
        const { path } = await verifyPendingTarget();
        if (!reviewedSpecification ||
            await safePath('requirement.spec.md') !== reviewedSpecification.path ||
            checksum(await sandbox.fs.readFile(reviewedSpecification.path, 'utf8')) !== reviewedSpecification.checksum) {
          throw new Error('Requirement specification changed during security review; revalidate before repairing.');
        }
        for (const [source, expectedChecksum] of Array.from(reviewedSources)) {
          if (await safePath(source) !== source || checksum(await sandbox.fs.readFile(source, 'utf8')) !== expectedChecksum) {
            throw new Error('Project source changed during security review; revalidate before repairing.');
          }
        }
        await assertCurrent();
        writeAttempted = true;
        await sandbox.writeFiles([{ path, content: args.sql }]);
        if (checksum(await sandbox.fs.readFile(path, 'utf8')) !== checksum(args.sql)) {
          throw new Error('Migration repair write could not be verified.');
        }
        changed = true;
        repairedTarget = { ...target, checksum: checksum(args.sql) };
        return { success: true, file: target.file, applied: false, message: 'SQL replaced. The harness must re-run the atomic migration gate.' };
      } catch (error) {
        // The assistant executor may turn tool exceptions into messages. Preserve
        // ambiguous failures out-of-band so the workflow cannot silently retry a write.
        failure = error;
        throw error;
      } finally {
        replacing = false;
      }
    },
  }];
  return {
    tools, wasChanged: () => changed, repairedTarget: () => repairedTarget,
    securityReview: () => securityReview,
    contextPaths: () => Array.from(contextPaths),
    writeAttempted: () => writeAttempted,
    assertHealthy: () => { if (failure) throw failure; },
    reviewBlockedMigration: async () => {
      if (reviewStarted) return securityReview;
      const { current } = await verifyPendingTarget();
      return review(current);
    },
  };
}