import type { MigrationRepairTarget } from '@/lib/services/apps-platform/migration-repair-types';

export type DatabaseMigrationOutcome =
  | { status: 'passed'; applied: string[]; errors: [] }
  | { status: 'failed'; applied: string[]; errors: string[]; failureKind: 'product' | 'infrastructure'; repairTarget?: MigrationRepairTarget };

/** A missing or failed receipt must never satisfy a required delivery gate. */
export function databaseMigrationsPassed(
  required: boolean,
  outcome?: DatabaseMigrationOutcome,
): boolean {
  return !required || (outcome?.status === 'passed' && outcome.errors.length === 0);
}