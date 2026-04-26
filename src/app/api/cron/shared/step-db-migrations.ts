'use step';

import { Sandbox } from '@vercel/sandbox';
import { connectOrRecreateRequirementSandbox } from '@/lib/services/sandbox-recovery';
import { applyPendingMigrations } from '@/lib/services/apps-platform/migration-applier';
import type { CronAuditContext } from '@/lib/services/cron-audit-log';

export async function applyDatabaseMigrationsStep(
  sandboxId: string,
  reqId: string,
  instanceType: string,
  title: string,
  audit?: CronAuditContext
): Promise<{ applied: string[]; errors: string[]; effectiveSandboxId: string }> {
  'use step';
  try {
    const connected = await connectOrRecreateRequirementSandbox({
      sandboxId,
      requirementId: reqId,
      instanceType,
      title: title?.trim() || reqId,
      audit,
    });
    
    const result = await applyPendingMigrations(connected.sandbox, reqId);
    
    return {
      applied: result.applied,
      errors: result.errors,
      effectiveSandboxId: connected.sandboxId,
    };
  } catch (err: any) {
    console.error('[CronStep] applyDatabaseMigrationsStep FAILED:', err?.message || err);
    return { applied: [], errors: [err?.message || String(err)], effectiveSandboxId: sandboxId };
  }
}
