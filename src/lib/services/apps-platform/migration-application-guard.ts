import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { lintMigration } from './migration-linter';
import { getTenantCapabilities } from './tenant-capabilities-service';
import { reviewMigrationSecurity } from './migration-security-review';
import { listMigrationLifecycle, transitionMigrationLifecycle, type MigrationLifecycleRecord } from './migration-lifecycle';
import type { MigrationRepairTarget } from './migration-repair-types';

export const migrationDigest = (text: string): string => createHash('sha256').update(text).digest('hex');
const MAX_ATTEMPTS = 5;

export interface MigrationApplicationContext {
  requirementId: string;
  executionGeneration: number;
  specification: string;
  specificationChecksum: string;
  instance: { id?: string; site_id: string; user_id?: string; requirement_id: string };
  assertCurrent: () => Promise<void>;
}

/** Canonical DB contract, never a caller-supplied specification or tenant identity. */
export async function loadMigrationApplicationContext(requirementId: string, assertOwner?: () => Promise<void>): Promise<MigrationApplicationContext> {
  const load = async () => {
    const { data, error } = await supabaseAdmin.from('requirements')
      .select('id,site_id,user_id,instructions,status,metadata').eq('id', requirementId).maybeSingle();
    if (error || !data) throw new Error('Migration requirement context is unavailable.');
    return data;
  };
  await assertOwner?.();
  const requirement = await load();
  const generation = Number(requirement.metadata?.requirement_execution_generation ?? 0);
  if (!Number.isSafeInteger(generation) || generation < 0 || !requirement.site_id) throw new Error('Invalid migration execution context.');
  const specification = typeof requirement.instructions === 'string' ? requirement.instructions : '';
  if (!specification.trim() || Buffer.byteLength(specification) > 64 * 1024) throw new Error('A complete bounded requirement specification is required before applying SQL.');
  const specificationChecksum = migrationDigest(specification);
  const assertCurrent = async () => {
    await assertOwner?.();
    const current = await load();
    if (Number(current.metadata?.requirement_execution_generation ?? 0) !== generation ||
        migrationDigest(current.instructions || '') !== specificationChecksum ||
        !['backlog', 'in-progress'].includes(current.status)) {
      throw new Error('Migration execution or specification changed; no SQL may be applied.');
    }
  };
  await assertCurrent();
  return {
    requirementId, executionGeneration: generation, specification, specificationChecksum, assertCurrent,
    instance: { id: requirement.metadata?.runner_instance_id, site_id: requirement.site_id,
      user_id: requirement.user_id || undefined, requirement_id: requirementId },
  };
}

export type MigrationApplicationDecision = {
  allowed: boolean;
  lifecycle: MigrationLifecycleRecord;
  error?: string;
};

/** All application entry points call this; a write-tool approval is not an apply receipt. */
export async function authorizeMigrationApplication(params: {
  context: MigrationApplicationContext;
  target: MigrationRepairTarget;
  sql: string;
  assertUnchanged: () => Promise<void>;
}): Promise<MigrationApplicationDecision> {
  const { context, target, sql, assertUnchanged } = params;
  await context.assertCurrent();
  if (migrationDigest(sql) !== target.checksum || Buffer.byteLength(sql) > 64 * 1024) throw new Error('Invalid migration bytes or size.');
  let current = (await listMigrationLifecycle(context.requirementId)).find(row => row.file === target.file);
  const transition = async (state: MigrationLifecycleRecord['state'], reason: string, attempts: number, review: unknown = null) => {
    current = await transitionMigrationLifecycle({
      requirementId: context.requirementId, file: target.file, expectedVersion: current?.version ?? 0,
      executionGeneration: context.executionGeneration,
      value: { state, checksum: state === 'platform_review' && current ? current.checksum : target.checksum,
        specification_checksum: state === 'platform_review' && current ? current.specification_checksum : context.specificationChecksum,
        original_sql: current?.original_sql ?? sql, reason: reason.slice(0, 1800), review, attempts },
    });
    return current;
  };
  if (current?.state === 'platform_review') return { allowed: false, lifecycle: current, error: current.reason };
  if (current && current.specification_checksum !== context.specificationChecksum) {
    const lifecycle = await transition('platform_review', 'Migration specification changed; reconcile the existing review before applying SQL.', current.attempts);
    return { allowed: false, lifecycle, error: lifecycle.reason };
  }
  if (current?.state === 'validation_pending') {
    const binding = current.review && typeof current.review === 'object'
      ? (current.review as Record<string, any>).binding : undefined;
    if (current.checksum !== target.checksum || current.specification_checksum !== context.specificationChecksum ||
        binding?.tenant_id !== target.tenantId || binding?.schema !== target.schema ||
        binding?.checksum !== target.checksum || binding?.specification_checksum !== context.specificationChecksum) {
      const lifecycle = await transition('platform_review', 'Previously reviewed migration or specification changed before validation completed.', current.attempts);
      return { allowed: false, lifecycle, error: lifecycle.reason };
    }
    await assertUnchanged();
    return { allowed: true, lifecycle: current };
  }
  if (current?.state === 'reviewing') {
    const lifecycle = await transition('platform_review', 'An interrupted or concurrent security review requires technical reconciliation.', current.attempts);
    return { allowed: false, lifecycle, error: lifecycle.reason };
  }
  if (current?.state === 'validated') {
    // Existing applied SQL is handled by the ledger before this function.
    const lifecycle = await transition('platform_review', 'A validated migration has no matching applied receipt. Do not replay it.', current.attempts);
    return { allowed: false, lifecycle, error: lifecycle.reason };
  }
  const lint = lintMigration({ sql, schema: target.schema, tenant_id: target.tenantId });
  if (!lint.ok) {
    const reason = lint.errors.map(issue => `${issue.rule}: ${issue.message}`).join('; ').slice(0, 1800);
    if (current?.state === 'correction_required' && current.checksum === target.checksum &&
        current.specification_checksum === context.specificationChecksum) return { allowed: false, lifecycle: current, error: reason };
    const lifecycle = await transition('correction_required', reason, current?.attempts ?? 0);
    return { allowed: false, lifecycle, error: reason };
  }
  if ((current?.attempts ?? 0) >= MAX_ATTEMPTS) {
    const lifecycle = await transition('platform_review', 'Bounded migration correction/review budget exhausted.', current!.attempts);
    return { allowed: false, lifecycle, error: lifecycle.reason };
  }
  const capabilities = await getTenantCapabilities(context.requirementId);
  if (capabilities.schema !== target.schema || capabilities.tenant_id !== target.tenantId) throw new Error('Migration tenant identity changed.');
  const reviewing = await transition('reviewing', 'Independent security review in progress.', (current?.attempts ?? 0) + 1);
  const review = await reviewMigrationSecurity({
    target, originalSql: reviewing.original_sql || sql, proposedSql: sql,
    specification: context.specification, errors: [], capabilities,
    instance: context.instance, assertCurrent: context.assertCurrent, reviewMode: 'application',
  });
  await context.assertCurrent();
  await assertUnchanged();
  const freshCapabilities = await getTenantCapabilities(context.requirementId);
  if (JSON.stringify(freshCapabilities) !== JSON.stringify(capabilities)) throw new Error('Tenant capabilities changed during security review.');
  if (review.decision !== 'approved_for_validation') {
    const lifecycle = await transition(review.decision === 'request_changes' ? 'correction_required' : 'platform_review', review.reason, reviewing.attempts, review);
    return { allowed: false, lifecycle, error: lifecycle.reason };
  }
  // Persist BEFORE application. A crash cannot erase the obligation to validate.
  const lifecycle = await transition('validation_pending', 'SQL approved; fresh application verification is still required.', reviewing.attempts, {
    ...review, binding: { tenant_id: target.tenantId, schema: target.schema, checksum: target.checksum,
      specification_checksum: context.specificationChecksum },
  });
  return { allowed: true, lifecycle };
}