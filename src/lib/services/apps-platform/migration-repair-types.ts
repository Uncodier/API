/** Only a verified, unapplied migration may enter automatic SQL repair. */
export interface MigrationRepairTarget {
  file: string;
  schema: string;
  tenantId: string;
  checksum: string;
  reason: 'lint' | 'sql';
}