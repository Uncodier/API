import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sql = readFileSync(resolve(
  process.cwd(),
  'supabase/migrations/20260925090000_append_plan_repair_step_atomic.sql',
), 'utf8');

describe('atomic plan repair step migration', () => {
  it('serializes, fences, deduplicates, and schedules runnable repair work', () => {
    expect(sql).toContain('FOR UPDATE');
    expect(sql).toContain('p_expected_source_generation');
    expect(sql).toContain("->>'repair_source_step_id' = p_source_step_id");
    expect(sql).toContain("->>'repair_run_id' = p_repair_run_id");
    expect(sql).toContain("'state', 'duplicate'");
    expect(sql).toContain(
      "v_source_step->>'status' IS DISTINCT FROM 'completed'",
    );
    expect(sql).toContain("v_plan.status NOT IN ('completed', 'in_progress')");
    expect(sql).toContain("step->>'id' = p_repair_step->>'id'");
    expect(sql).toContain("'status', 'pending'");
    expect(sql).toContain("status = 'in_progress'");
    expect(sql).toContain('completed_at = NULL');
  });
});