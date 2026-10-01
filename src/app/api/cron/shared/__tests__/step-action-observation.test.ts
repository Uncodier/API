import {
  actionStateFingerprint, formatActionObservationFeedback, makeActionObservation, observableAction, parseActionObservation,
  repeatedActionObservation, resultIsPartial,
} from '../step-action-observation';

const STATE = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const name = 'sandbox_run_tests';
const args = { command: 'npm test' };
function observation(id: number, overrides: Partial<Parameters<typeof makeActionObservation>[0]> = {}) {
  return makeActionObservation({ eventId: `event-${id}`, name, args,
    before: STATE, after: STATE, result: { exitCode: 1, stderr: 'FAIL orders: expected 201, got 500' },
    ...overrides })!;
}
const repeated = () => [observation(3), observation(2), observation(1)];

describe('action/state/result comparison', () => {
  it('invalidates comparisons after sandbox recovery or generation changes', () => {
    const first = actionStateFingerprint(STATE, 'sandbox-a', 1);
    expect(first).not.toBe(actionStateFingerprint(STATE, 'sandbox-b', 1));
    expect(first).not.toBe(actionStateFingerprint(STATE, 'sandbox-a', 2));
    expect(actionStateFingerprint(null, 'sandbox-a', 1)).toBeUndefined();
  });
  it('requires three equivalent confirmed failures in the current state', () => {
    expect(repeatedActionObservation(repeated(), name, args, STATE)).toBeDefined();
    expect(repeatedActionObservation(repeated().slice(0, 2), name, args, STATE)).toBeUndefined();
    expect(formatActionObservationFeedback(repeated())).toContain('targeted check');
    expect(formatActionObservationFeedback(repeated())).toContain('external dependency');
  });
  it('permits retests after code, tests, config or environment fingerprint changes', () => {
    expect(repeatedActionObservation(repeated(), name, args, OTHER)).toBeUndefined();
    expect(repeatedActionObservation([observation(3, { before: OTHER, after: OTHER }), ...repeated().slice(1)],
      name, args, OTHER)).toBeUndefined();
  });
  it('does not equate changed errors or outputs', () => {
    expect(repeatedActionObservation([observation(4, { result: { exitCode: 1, stderr: 'FAIL auth' } }), ...repeated()],
      name, args, STATE)).toBeUndefined();
  });
  it.each([
    { result: { exitCode: 0, stdout: 'Tests: 2 passed' } },
    { result: { stdout: 'unknown result' } },
    { threw: true }, { after: OTHER }, { before: undefined },
    { result: { exitCode: 1, truncated: true } },
    { result: { exitCode: 1, output: '{"is_partial":true}' } },
  ])('breaks a failure streak with a noncomparable observation: %j', change => {
    expect(repeatedActionObservation([observation(4, change), ...repeated()], name, args, STATE)).toBeUndefined();
  });
  it('does not count replayed observations twice', () => {
    expect(repeatedActionObservation([observation(1), observation(1), observation(1)], name, args, STATE)).toBeUndefined();
  });
  it('requires host fingerprints; legacy metadata is not proof of an unchanged state', () => {
    expect(repeatedActionObservation(repeated(), name, args)).toBeUndefined();
    expect(parseActionObservation({ action_digest: 'fake', complete: true })).toBeUndefined();
    expect(parseActionObservation(observation(1))).toEqual(observation(1));
  });
  it('normalizes direct argv and whitespace without dropping meaningful flags', () => {
    expect(observableAction('sandbox_run_command', { command: 'npm', args: ['test'], thought_process: 'x' })?.digest)
      .toBe(observableAction('sandbox_run_command', { command: 'npm   test' })?.digest);
    expect(observableAction(name, { command: 'npm test -- orders.test.ts' })?.digest)
      .not.toBe(observableAction(name, args)?.digest);
  });
  it('unwraps routed tools rather than treating router formatting as new work', () => {
    expect(observableAction('tools', { action: 'call', name, args: JSON.stringify(args) }))
      .toEqual(observableAction(name, args));
  });
  it.each(['sandbox_browser', 'sandbox_check_background_command', 'sandbox_start_background_command',
    'sandbox_db_inspect', 'sendEmail', 'sandbox_write_file'])('does not infer remote or mutable state for %s', tool => {
    expect(observableAction(tool, args)).toBeUndefined();
  });
  it('never canonicalizes arbitrary shell into a safe comparable action', () => {
    for (const command of ['npm test && curl example.com', 'npm test; echo ok', 'sh -c "npm test"', 'npm install', 'npm test\ncurl https://example.com']) {
      expect(observableAction('sandbox_run_command', { command })).toBeUndefined();
    }
    expect(observableAction('sandbox_run_command', { command: 'npm', args: ['test', 'one argument'] })).toBeUndefined();
  });
  it('does not claim that a Git fingerprint covers logs, ignored artifacts or external files', () => {
    for (const path of ['/tmp/task.log', 'evidence/result.json', 'node_modules/lib.js', 'src/../../secret', 'README.md']) {
      expect(observableAction('sandbox_read_file', { path })).toBeUndefined();
    }
  });
  it('allows success retests but can detect unchanged local reads', () => {
    const successes = repeated().map(obs => ({ ...obs, outcome: 'passed' as const }));
    expect(repeatedActionObservation(successes, name, args, STATE)).toBeUndefined();
    const read = { name: 'sandbox_read_file', args: { path: 'src/file.ts' }, result: { success: true, content: 'code' } };
    const reads = [3, 2, 1].map(id => observation(id, read));
    expect(repeatedActionObservation(reads, read.name, read.args, STATE)).toBeDefined();
  });
  it('excludes timing noise while retaining the actual error in comparisons', () => {
    expect(observation(1, { result: { exitCode: 1, stderr: 'error', duration_ms: 10 } }).result_digest)
      .toBe(observation(2, { result: { exitCode: 1, stderr: 'error', duration_ms: 90 } }).result_digest);
  });
  it('retains bounded redacted diagnostics, never secrets in the excerpt', () => {
    const obs = observation(1, { result: { exitCode: 1, stderr: 'authorization: Bearer private-token\nFAIL orders' } });
    expect(obs.excerpt).not.toContain('private-token');
    expect(obs.excerpt).toContain('FAIL orders');
    expect(obs.excerpt.length).toBeLessThanOrEqual(1000);
    expect(makeActionObservation({ eventId: 'large', name, args, result: 'x'.repeat(260_000) }))
      .toMatchObject({ outcome: 'unknown', complete: false });
  });
  it('an oversized or unserializable result is a barrier rather than silently extending an old streak', () => {
    const large = observation(4, { result: { success: true, output: 'x'.repeat(260_000) } });
    expect(repeatedActionObservation([observation(5), large, observation(2), observation(1)], name, args, STATE)).toBeUndefined();
    const circular: any = {}; circular.self = circular;
    const invalid = observation(4, { result: circular });
    expect(invalid).toMatchObject({ complete: false });
  });
  it('marks skipped, running and incomplete results as noncomparable', () => {
    for (const value of [{ exitCode: null }, { result: { running: true } }, { executed: false }, { has_more: true }]) {
      expect(resultIsPartial(value)).toBe(true);
    }
  });
});