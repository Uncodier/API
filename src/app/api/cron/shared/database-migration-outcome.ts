export type DatabaseMigrationOutcome =
  | { status: 'passed'; applied: string[]; errors: [] }
  | { status: 'failed'; applied: string[]; errors: string[]; failureKind: 'product' | 'infrastructure' };

/** A missing or failed receipt must never satisfy a required delivery gate. */
export function databaseMigrationsPassed(
  required: boolean,
  outcome?: DatabaseMigrationOutcome,
): boolean {
  return !required || (outcome?.status === 'passed' && outcome.errors.length === 0);
}