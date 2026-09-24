import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

function migration(name: string): string {
  return fs.readFileSync(
    path.join(process.cwd(), 'supabase', 'migrations', name),
    'utf8',
  );
}

describe('Redis offload durability contracts', () => {
  it('checkpoints quota high-water marks without decreasing usage', () => {
    const sql = migration(
      '20260921173000_checkpoint_platform_quota_usage.sql',
    );
    expect(sql).toContain(
      'GREATEST(public.platform_quotas.used, EXCLUDED.used)',
    );
    expect(sql).toContain('reserve_platform_quota');
    expect(sql).toContain('quota.used + GREATEST(p_cost, 1)');
    expect(sql).toContain('TO service_role');
    expect(sql).toContain('FROM PUBLIC, anon, authenticated');
  });

  it('maintains bounded conversation summaries on message changes', () => {
    const sql = migration(
      '20260921174500_conversation_message_summaries.sql',
    );
    expect(sql).toContain('last_message_preview jsonb');
    expect(sql).toContain('message_count bigint NOT NULL DEFAULT 0');
    expect(sql).toContain('AFTER INSERT OR UPDATE OF');
  });

  it('claims synced objects in one atomic database call', () => {
    const sql = migration(
      '20260921181500_claim_synced_objects_batch.sql',
    );
    const ambiguityFix = migration(
      '20260924223000_resolve_synced_object_claim_ambiguity.sql',
    );
    expect(sql).toContain('ON CONFLICT');
    expect(sql).toContain('DO NOTHING');
    expect(sql).toContain("status = 'processing'");
    expect(sql).toContain('claim_expires_at');
    expect(sql).toContain('synced.claim_token');
    expect(sql).toContain('TO service_role');
    expect(ambiguityFix).toContain(
      'CREATE OR REPLACE FUNCTION public.claim_synced_objects_batch',
    );
    expect(ambiguityFix).toContain('#variable_conflict use_column');
    expect(ambiguityFix).toContain(
      'ON CONFLICT (external_id, site_id, object_type) DO NOTHING',
    );
    expect(ambiguityFix).toContain('TO service_role');
  });

  it('buffers system-memory access counts behind an atomic increment', () => {
    const sql = migration(
      '20260921180000_increment_system_memory_access.sql',
    );
    expect(sql).toContain('access_count = access_count +');
    expect(sql).toContain('TO service_role');
  });

  it('loads ready pending work without per-instance status queries', () => {
    const sql = migration(
      '20260921183000_load_ready_pending_work.sql',
    );
    expect(sql).toContain('DISTINCT ON (pending.instance_id)');
    expect(sql).toContain("log.details->>'status' = 'running'");
    expect(sql).toContain('FOR UPDATE OF pending SKIP LOCKED');
    expect(sql).toContain('TO service_role');
  });
});
