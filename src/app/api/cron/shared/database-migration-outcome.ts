import type { MigrationRepairTarget } from '@/lib/services/apps-platform/migration-repair-types';
import type { MigrationLifecycleRecord } from '@/lib/services/apps-platform/migration-lifecycle';

export type DatabaseMigrationOutcome =
  | { status: 'passed'; applied: string[]; errors: [] }
  | { status: 'failed'; applied: string[]; errors: string[]; failureKind: 'product' | 'infrastructure'; repairTarget?: MigrationRepairTarget; correction?: MigrationLifecycleRecord };

/** A missing or failed receipt must never satisfy a required delivery gate. */
export function databaseMigrationsPassed(
  required: boolean,
  outcome?: DatabaseMigrationOutcome,
): boolean {
  return !required || (outcome?.status === 'passed' && outcome.errors.length === 0);
}