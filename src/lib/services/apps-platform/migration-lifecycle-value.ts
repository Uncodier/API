import type { MigrationLifecycleRecord, MigrationLifecycleTransitionInput } from './migration-lifecycle';

/** Exclude row keys/version/timestamps from the strict mutation contract. */
export function migrationLifecycleValue(row: MigrationLifecycleRecord,
  patch: Partial<MigrationLifecycleTransitionInput['value']> = {}): MigrationLifecycleTransitionInput['value'] {
  return { state: row.state, checksum: row.checksum, specification_checksum: row.specification_checksum,
    original_sql: row.original_sql, reason: row.reason, review: row.review, attempts: row.attempts, ...patch };
}