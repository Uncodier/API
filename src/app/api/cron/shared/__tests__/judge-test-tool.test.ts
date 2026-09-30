import { createJudgeTestTool } from '../judge-test-tool';
import { runDeclaredTestCommand } from '../step-test-evidence';
import { computeApplicationBuildFingerprint } from '../commit/pre-push-build-validation';
import { writeEvidence } from '@/lib/services/requirement-ground-truth';

jest.mock('../step-test-evidence', () => ({ runDeclaredTestCommand: jest.fn() }));
jest.mock('../commit/pre-push-build-validation', () => ({ computeApplicationBuildFingerprint: jest.fn() }));
jest.mock('@/lib/services/requirement-ground-truth', () => ({ writeEvidence: jest.fn() }));
jest.mock('@/lib/services/sandbox-service', () => ({ SandboxService: { WORK_DIR: '/vercel/sandbox' } }));

const assertCurrent = jest.fn();
const sandbox = {} as any;
const tool = () => createJudgeTestTool({ sandbox: () => sandbox, requirementId: 'req',
  backlogItemId: 'item', stepId: 'step', assertCurrent });
const fingerprint = computeApplicationBuildFingerprint as jest.Mock;
const run = runDeclaredTestCommand as jest.Mock;
const persist = writeEvidence as jest.Mock;

beforeEach(() => {
  jest.resetAllMocks();
  assertCurrent.mockResolvedValue(undefined);
  fingerprint.mockResolvedValue('current');
  run.mockResolvedValue({ ok: true, tests: [{ command: 'npm test', exit_code: 0, output_tail: 'PASS tests/api.test.ts\nTests: 4 passed, 4 total',
    ran_after_changes: true, step_id: 'step', workspace_fingerprint: 'current', captured_at: '2026-09-30T00:00:00Z' }] });
  persist.mockResolvedValue({});
});

it('executes bounded tests and persists current host evidence before returning success', async () => {
  const result = await tool().execute({ command: 'npm test' });
  expect(result).toMatchObject({ success: true, receipt: { kind: 'test_execution', step_id: 'step', workspace_fingerprint: 'current' } });
  expect(run).toHaveBeenCalledWith(sandbox, 'npm test', { timeoutMs: 180000, stepId: 'step', workspaceFingerprint: 'current' });
  expect(persist).toHaveBeenCalledWith(expect.objectContaining({ requirementId: 'req', itemId: 'item', requireCanonicalPersistence: true,
    record: expect.objectContaining({ tests: [expect.objectContaining({ ran_after_changes: true, exit_code: 0 })] }) }));
  expect(assertCurrent).toHaveBeenCalledTimes(3);
});

it.each(['echo npm test', 'cat jest.config.js', 'npm test || true', 'sh -c "npm test"', 'node --test --version', 'npm test -- --help', 'npm test -- --listTests', 'npm test -- --passWithNoTests'])('does not execute %s', async command => {
  expect(await tool().execute({ command })).toMatchObject({ success: false });
  expect(run).not.toHaveBeenCalled();
  expect(persist).not.toHaveBeenCalled();
});

it.each(['v22.1.0', 'No tests found', 'Tests: 0 passed, 0 total', '# tests 0', 'PASS'])('never persists a passing receipt without executed tests (%s)', async output => {
  run.mockResolvedValue({ ok: true, tests: [{ command: 'npm test', exit_code: 0, output_tail: output }] });
  expect(await tool().execute({ command: 'npm test' })).toMatchObject({ success: false });
  expect(persist).not.toHaveBeenCalled();
});

it('does not execute without workspace identity', async () => {
  fingerprint.mockResolvedValue(undefined);
  expect(await tool().execute({ command: 'npm test' })).toMatchObject({ success: false });
  expect(run).not.toHaveBeenCalled();
});

it('does not approve tests when files changed during execution', async () => {
  fingerprint.mockResolvedValueOnce('before').mockResolvedValueOnce('after');
  expect(await tool().execute({ command: 'npm test' })).toMatchObject({ success: false,
    receipt: { tests: [expect.objectContaining({ ran_after_changes: false })] } });
});

it('retains failed and timed-out test outcomes rather than accepting a completed process', async () => {
  run.mockResolvedValue({ ok: false, tests: [{ command: 'npm test', exit_code: 124, output_tail: 'Timed out',
    ran_after_changes: true, step_id: 'step', workspace_fingerprint: 'current' }] });
  expect(await tool().execute({ command: 'npm test' })).toMatchObject({ success: false, receipt: { tests: [{ exit_code: 124 }] } });
});

it('cannot return success when evidence persistence fails', async () => {
  persist.mockRejectedValue(new Error('persistence unavailable'));
  await expect(tool().execute({ command: 'npm test' })).rejects.toThrow('persistence unavailable');
});

it('respects lost execution ownership before running or persisting tests', async () => {
  assertCurrent.mockRejectedValueOnce(new Error('stale'));
  await expect(tool().execute({ command: 'npm test' })).rejects.toThrow('stale');
  expect(run).not.toHaveBeenCalled();
  expect(persist).not.toHaveBeenCalled();
  assertCurrent.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('stale'));
  await expect(tool().execute({ command: 'npm test' })).rejects.toThrow('stale');
  expect(persist).not.toHaveBeenCalled();
});