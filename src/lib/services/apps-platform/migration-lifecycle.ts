import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';

export type MigrationLifecycleState =
  | 'correction_required'
  | 'reviewing'
  | 'validation_pending'
  | 'validated'
  | 'platform_review';

export interface MigrationLifecycleRecord {
  requirement_id: string;
  file: string;
  version: number;
  state: MigrationLifecycleState;
  checksum: string;
  specification_checksum: string;
  original_sql: string | null;
  reason: string;
  review: unknown | null;
  attempts: number;
  updated_at: string;
}

export interface MigrationLifecycleTransitionInput {
  requirementId: string;
  file: string;
  /** Zero means the row must not exist. Every successful transition increments it. */
  expectedVersion: number;
  executionGeneration: number;
  value: {
    state: MigrationLifecycleState;
    checksum: string;
    specification_checksum: string;
    original_sql?: string | null;
    reason: string;
    review?: unknown;
    attempts: number;
  };
}

const fileSchema = z.string().max(512).regex(
  /^(?:migrations|supabase\/migrations|src\/db\/migrations|platform)\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.sql$/,
).refine(file => !/[\r\n]/.test(file));
const checksumSchema = z.string().length(64).regex(/^[a-f0-9]{64}$/);
const originalSqlSchema = z.string().refine(sql => Buffer.byteLength(sql, 'utf8') <= 64 * 1024).nullable();
const valueSchema = z.object({
  state: z.enum(['correction_required', 'reviewing', 'validation_pending', 'validated', 'platform_review']),
  checksum: checksumSchema,
  specification_checksum: checksumSchema,
  original_sql: originalSqlSchema.optional(),
  reason: z.string().max(2048),
  review: z.unknown().optional(),
  attempts: z.number().int().min(0).max(5),
}); // Strip row identity/version fields when callers spread a prior receipt.
const recordSchema = valueSchema.extend({
  requirement_id: z.string().uuid(),
  file: fileSchema,
  version: z.number().int().min(1).max(2147483647),
  original_sql: originalSqlSchema,
  review: z.unknown(),
  updated_at: z.string().datetime({ offset: true }),
}).strict();
const inputSchema = z.object({
  requirementId: z.string().uuid(),
  file: fileSchema,
  expectedVersion: z.number().int().min(0).max(2147483646),
  executionGeneration: z.number().int().min(0).max(2147483647),
  value: valueSchema,
}).strict();

const columns = 'requirement_id,file,version,state,checksum,specification_checksum,original_sql,reason,review,attempts,updated_at';

function parseRecord(value: unknown): MigrationLifecycleRecord {
  const parsed = recordSchema.safeParse(value);
  // z.unknown() accepts undefined; a full persisted row must still include review.
  if (!parsed.success || !Object.prototype.hasOwnProperty.call(value, 'review') || parsed.data.review === undefined) {
    throw new Error('Invalid migration lifecycle response.');
  }
  return parsed.data as MigrationLifecycleRecord;
}

/** Makinari service-role read, never Apps tenant credentials or user-selected clients. */
export async function listMigrationLifecycle(requirementId: string): Promise<MigrationLifecycleRecord[]> {
  const id = z.string().uuid().parse(requirementId);
  const { data, error } = await supabaseAdmin.from('requirement_migration_lifecycle')
    .select(columns).eq('requirement_id', id);
  if (error) throw new Error(`Migration lifecycle lookup failed (${error.code || 'lookup_failed'}).`);
  if (!Array.isArray(data)) throw new Error('Invalid migration lifecycle response.');
  const rows = data.map(parseRecord);
  const files = new Set<string>();
  for (const row of rows) {
    if (row.requirement_id !== id.toLowerCase() || files.has(row.file)) {
      throw new Error('Invalid migration lifecycle scope or duplicate file.');
    }
    files.add(row.file);
  }
  return rows;
}

/** No upsert/fallback: missing RPC, stale leases, and malformed receipts fail closed. */
export async function transitionMigrationLifecycle(input: MigrationLifecycleTransitionInput): Promise<MigrationLifecycleRecord> {
  const parsed = inputSchema.parse(input);
  const { data, error } = await supabaseAdmin.rpc('transition_requirement_migration', {
    p_requirement_id: parsed.requirementId,
    p_file: parsed.file,
    p_expected_version: parsed.expectedVersion,
    p_expected_execution_generation: parsed.executionGeneration,
    p_value: parsed.value,
  });
  if (error) throw new Error(`Migration lifecycle transition failed (${error.code || 'transition_failed'}).`);
  const row = parseRecord(data);
  if (row.requirement_id !== parsed.requirementId.toLowerCase() || row.file !== parsed.file ||
      row.version !== parsed.expectedVersion + 1 || row.state !== parsed.value.state ||
      row.checksum !== parsed.value.checksum || row.specification_checksum !== parsed.value.specification_checksum ||
      row.attempts !== parsed.value.attempts || row.reason !== parsed.value.reason ||
      (parsed.value.original_sql !== undefined && row.original_sql !== parsed.value.original_sql)) {
    throw new Error('Invalid migration lifecycle transition receipt.');
  }
  return row;
}