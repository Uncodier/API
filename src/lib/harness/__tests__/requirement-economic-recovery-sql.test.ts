import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const recoveryMigration = 'supabase/migrations/20261114210000_requirement_economic_recovery_contention.sql';

it('replays all requirement cron SQL guards with contention recovery installed at the recovery boundary', () => {
  // Reuse the complete regression script without modifying the oversized test.
  const source = readFileSync('src/lib/harness/__tests__/requirement-cron-sql.test.ts', 'utf8');
  const script = source.split('const script = String.raw`')[1].split('`;\n  const child')[0];
  const boundary = "await db.exec(readFileSync('supabase/migrations/20261026030000_requirement_pause_recovery_commands.sql','utf8'));";
  expect(script.split(boundary)).toHaveLength(2);
  const injected = script.replace(boundary, `${boundary}\nawait db.exec(readFileSync('${recoveryMigration}','utf8'));`);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', injected], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
  });
  expect({ status: child.status, stderr: child.stderr, error: child.error }).toEqual({ status: 0, stderr: '', error: undefined });
}, 130_000);

it('retains the complete authorization, quiescence, provenance, accounting and command guard body', () => {
  const original = readFileSync('supabase/migrations/20261026030000_requirement_pause_recovery_commands.sql', 'utf8');
  const forward = readFileSync(recoveryMigration, 'utf8');
  const guards = (sql: string) => sql.slice(sql.indexOf('      IF public.requirement_pause_command_guard'), sql.indexOf('    EXCEPTION'));
  expect(guards(forward)).toBe(guards(original));
  expect(forward).toContain('ORDER BY checked_at,requirement_id LIMIT 100');
  expect(forward).toContain('SET lock_timeout = \'50ms\'');
  expect(forward).toContain('REVOKE ALL ON FUNCTION public.recheck_requirement_economic_pauses(uuid[]) FROM PUBLIC,anon,authenticated,service_role;');
});
