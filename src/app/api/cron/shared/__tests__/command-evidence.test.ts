import { describe, expect, it } from '@jest/globals';
import type { CommandEvidenceSignal, EvidenceRecord } from '@/lib/services/requirement-evidence-types';
import { matchCommandEvidence } from '@/lib/services/requirement-command-evidence';
import { mergeEvidenceRecords } from '@/lib/services/requirement-ground-truth';
import { matchAcceptanceAgainstEvidence } from '../archetype-acceptance-match';
import { runJudge } from '../archetype-runner';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: {} }));

function command(overrides: Partial<CommandEvidenceSignal> = {}): CommandEvidenceSignal {
  return {
    command: 'npm run lint', exit_code: 0, output_tail: 'No lint findings',
    ran_after_changes: true, captured_at: '2026-10-01T00:00:00.000Z',
    step_id: 'step-1', workspace_fingerprint: 'workspace-1', ...overrides,
  };
}

function evidence(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    schema_version: 1, item_id: 'item-1', captured_at: '2026-10-01T00:00:00.000Z',
    evidence_run_id: 'run-1', critic_passes: 0,
    producer_step_id: 'step-1', workspace_fingerprint: 'workspace-1', ...overrides,
  };
}

function match(expected: string, record: EvidenceRecord) {
  const text = `Command ${expected} succeeds`;
  return matchAcceptanceAgainstEvidence([text], record, {
    schema_version: 1,
    criteria: [{ id: 'criterion-1', text, all_of: [{ kind: 'command', command: expected }] }],
  });
}

describe('canonical command evidence matching', () => {
  it('real Judge accepts DB test/build/lint evidence without misclassifying lint as a test', () => {
    const acceptance = ['npm test -- db_schema.test.ts exits 0', 'npm run build exits 0', 'npm run lint exits 0'];
    const record = evidence({ commands: [command()],
      tests: [{ ...command({ command: 'npm test -- db_schema.test.ts' }), output_tail: 'Tests: 1 passed, 1 total' }],
      build: { command: 'npm run build', exit_code: 0, duration_ms: 1 },
      changed_files: ['src/db/schema.ts'], runtime: { route: '/', http_status: 200 } });
    const result = matchAcceptanceAgainstEvidence(acceptance, record);
    expect(result.unmatched).toEqual([]);
    expect(result.contradicted).toEqual([]);
    const judge = runJudge({ item: { id: 'item-1', title: 'DB validation', kind: 'integration', phase_id: 'build',
      status: 'in_progress', scope_level: 'full', tier: 'core', attempts: 0, acceptance }, flow: 'app', evidence: record });
    expect(judge.verdict).toBe('approved');
  });
  it.each(['npm run lint', 'pnpm lint', 'yarn run lint', 'bun run lint'])('matches deliberate lint alias: %s', (invocation) => {
    expect(matchCommandEvidence('lint', evidence({ commands: [command({ command: invocation })] }))).toBe('pass');
  });

  it.each(['npm run lint:fix', 'npm run lint -- --fix', 'echo npm run lint', 'npm run Lint'])('does not accept a different command: %s', (invocation) => {
    const result = match('lint', evidence({ commands: [command({ command: invocation })] }));
    expect(result.matched).toEqual([]);
    expect(result.diagnostics[0]).toMatchObject({ status: 'missing', gaps: [{ code: 'missing_command_receipt' }] });
  });

  it('exact declared invocations do not accept package-manager replacements or extra arguments', () => {
    const record = evidence({ commands: [command({ command: 'pnpm run lint' })] });
    expect(matchCommandEvidence('npm run lint', record)).toBe('unknown');
    expect(matchCommandEvidence('pnpm  run lint', record)).toBe('pass');
    expect(matchCommandEvidence('pnpm run lint -- --fix', record)).toBe('unknown');
  });

  it.each(['build', 'typecheck'])('matches current %s canonical receipt', (script) => {
    expect(match(script, evidence({ commands: [command({ command: `npm run ${script}` })] })).matched).toHaveLength(1);
  });

  it('a current nonzero receipt contradicts a passing receipt and diagnostic reports product failure', () => {
    const record = evidence({ commands: [command(), command({ command: 'pnpm lint', exit_code: 1 })] });
    const result = match('lint', record);
    expect(result.contradicted).toHaveLength(1);
    expect(result.matched).toEqual([]);
    expect(result.diagnostics[0]).toMatchObject({
      status: 'contradicted', gaps: [{ code: 'missing_command_receipt', class: 'product' }],
    });
  });

  it('canonical build failure is not hidden by a legacy successful build', () => {
    expect(matchCommandEvidence('build', evidence({
      commands: [command({ command: 'npm run build', exit_code: 1 })],
      build: { command: 'npm run build', exit_code: 0, duration_ms: 1 },
    }))).toBe('fail');
  });

  it.each([
    { workspace_fingerprint: 'older-workspace', exit_code: 1 },
    { step_id: 'older-step', exit_code: 1 },
    { ran_after_changes: false },
    { captured_at: 'not-a-date' },
    { criterion_id: 'other-criterion' },
  ])('rejects stale/unscoped command signals: %j', (override) => {
    expect(match('lint', evidence({ commands: [command(override)] })).unmatched).toHaveLength(1);
  });

  it('lint and build commands never fabricate automated test evidence', () => {
    const record = evidence({
      commands: [command(), command({ command: 'npm run build' })],
      tests: [command()], // Even a wrongly classified historical lint is not a test.
    });
    expect(matchCommandEvidence('test', record)).toBe('unknown');
    expect(match('test', record).matched).toEqual([]);
    expect(record.commands).toHaveLength(2);
  });

  it('preserves legacy build and genuine test command acceptance', () => {
    expect(matchCommandEvidence('build', evidence({ build: {
      command: 'npm run build', exit_code: 0, duration_ms: 1,
    } }))).toBe('pass');
    expect(matchCommandEvidence('test', evidence({ tests: [command({
      command: 'npm test -- example.test.ts',
    })] }))).toBe('pass');
    expect(matchCommandEvidence('test', evidence({ tests: [command({
      command: 'npx vitest run',
    })] }))).toBe('pass');
  });
});

describe('canonical command evidence merge', () => {
  it('retains same-step current commands when a new evidence run replaces other evidence', () => {
    const prior = evidence({ commands: [command()], tests: [command({ command: 'npm test' })] });
    const merged = mergeEvidenceRecords(prior, {
      schema_version: 1, item_id: 'item-1', captured_at: prior.captured_at,
      evidence_run_id: 'run-2', producer_step_id: 'step-1', workspace_fingerprint: 'workspace-1',
      observations: [],
    });
    expect(merged.commands).toEqual(prior.commands);
    expect(merged.tests).toBeUndefined();
    expect(merged.evidence_run_id).toBe('run-2');
  });

  it('postgate can preserve commands at the same fingerprint without overwriting producer identity', () => {
    const prior = evidence({ commands: [command()] });
    const merged = mergeEvidenceRecords(prior, {
      schema_version: 1, item_id: 'item-1', captured_at: prior.captured_at,
      evidence_run_id: 'run-2', workspace_fingerprint: 'workspace-1',
    });
    expect(merged.commands).toEqual(prior.commands);
    expect(matchCommandEvidence('lint', merged)).toBe('pass');
  });

  it.each([
    { producer_step_id: 'step-2', workspace_fingerprint: 'workspace-1' },
    { producer_step_id: 'step-1', workspace_fingerprint: 'workspace-2' },
    {},
  ])('does not carry receipts to a stale/unknown new scope: %j', (scope) => {
    const prior = evidence({ commands: [command()] });
    expect(mergeEvidenceRecords(prior, {
      schema_version: 1, item_id: 'item-1', captured_at: prior.captured_at,
      evidence_run_id: 'run-2', ...scope,
    }).commands).toBeUndefined();
  });

  it('merges distinct exact commands and replaces the same scoped command without creating tests', () => {
    const prior = evidence({ commands: [command()] });
    const merged = mergeEvidenceRecords(prior, {
      schema_version: 1, item_id: 'item-1', captured_at: prior.captured_at,
      commands: [command({ exit_code: 1 }), command({ command: 'npm run build' })],
    });
    expect(merged.commands?.map((receipt) => [receipt.command, receipt.exit_code])).toEqual([
      ['npm run lint', 1], ['npm run build', 0],
    ]);
    expect(merged.tests).toBeUndefined();
  });
});