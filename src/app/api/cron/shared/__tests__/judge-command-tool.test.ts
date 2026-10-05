import { randomBytes } from 'node:crypto';
import { createJudgeCommandTool } from '../judge-command-tool';
import { computeApplicationBuildFingerprint } from '../commit/pre-push-build-validation';
import { writeEvidence } from '@/lib/services/requirement-ground-truth';

jest.mock('../commit/pre-push-build-validation', () => ({ computeApplicationBuildFingerprint: jest.fn() }));
jest.mock('@/lib/services/requirement-ground-truth', () => ({ writeEvidence: jest.fn() }));
jest.mock('@/lib/services/sandbox-service', () => ({ SandboxService: { WORK_DIR: '/vercel/sandbox' } }));
const owner = jest.fn();
const readFile = jest.fn();
const run = jest.fn();
const fingerprint = computeApplicationBuildFingerprint as jest.Mock;
const persist = writeEvidence as jest.Mock;
const tool = () => createJudgeCommandTool({ sandbox: () => ({ fs: { readFile }, runCommand: run } as any),
  requirementId: 'req', backlogItemId: 'item', stepId: 'step', assertCurrent: owner,
  action: { action_id: 'lint', kind: 'collect_evidence', gap_code: 'missing_command_receipt', command: 'npm run lint',
    expected_receipt: 'command_execution', instruction: 'Run lint', verification: 'Fresh receipt' } });
beforeEach(() => {
  jest.resetAllMocks(); owner.mockResolvedValue(undefined); fingerprint.mockResolvedValue('current');
  readFile.mockResolvedValue(JSON.stringify({ scripts: { lint: 'eslint .' } }));
  run.mockResolvedValue({ exitCode: 0, stdout: async () => 'Lint passed', stderr: async () => '' });
  persist.mockResolvedValue({});
});

it('executes only the host-bound existing validator with server-side timeout and canonical persistence', async () => {
  expect(await tool().execute({})).toMatchObject({ success: true, receipt: { kind: 'command_execution',
    commands: [{ command: 'npm run lint', exit_code: 0, workspace_fingerprint: 'current' }] } });
  expect(run).toHaveBeenCalledWith({ cmd: 'npm', args: ['run', 'lint'], cwd: '/vercel/sandbox', timeoutMs: 180000 });
  expect(persist).toHaveBeenCalledWith(expect.objectContaining({ requireCanonicalPersistence: true,
    record: expect.objectContaining({ commands: [expect.objectContaining({ ran_after_changes: true })] }) }));
  expect(persist.mock.calls[0][0].record).not.toHaveProperty('tests');
});

it.each([{ scripts: {} }, { scripts: { lint: 'echo ok' } }, { scripts: { lint: 'eslint . || true' } },
  { scripts: { lint: 'eslint . --fix' } }, { scripts: { lint: 'eslint .', prelint: 'node mutate.js' } },
  { scripts: { lint: 'eslint .', postlint: 'npm run migrate' } }])('does not execute unsafe/missing script %j', pkg => {
  readFile.mockResolvedValue(JSON.stringify(pkg));
  return tool().execute({}).then(result => {
    expect(result).toMatchObject({ success: false, code: 'VALIDATION_PRODUCT_FAILURE' });
    expect(run).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled();
  });
});

it('cannot succeed without stable workspace identity', async () => {
  fingerprint.mockResolvedValueOnce('before').mockResolvedValueOnce('before').mockResolvedValueOnce('after');
  expect(await tool().execute({})).toMatchObject({ success: false, receipt: { commands: [{ ran_after_changes: false }] } });
});

it('does not execute when workspace changes during preparation', async () => {
  fingerprint.mockResolvedValueOnce('before').mockResolvedValueOnce('after');
  expect(await tool().execute({})).toMatchObject({ success: false }); expect(run).not.toHaveBeenCalled();
});

it('keeps nonzero and timed out validator receipts truthful', async () => {
  run.mockResolvedValue({ exitCode: 124, stdout: async () => 'Timed out', stderr: async () => '' });
  expect(await tool().execute({})).toMatchObject({ success: false, code: 'VALIDATION_PRODUCT_FAILURE', receipt: { commands: [{ exit_code: 124 }] } });
});

it('does not fabricate success for an unreadable process outcome or unavailable persistence', async () => {
  run.mockRejectedValueOnce(new Error('transport unavailable'));
  await expect(tool().execute({})).rejects.toThrow('transport unavailable'); expect(persist).not.toHaveBeenCalled();
  persist.mockRejectedValueOnce(new Error('persistence unavailable'));
  await expect(tool().execute({})).rejects.toThrow('persistence unavailable');
});

it('keeps an unknown exit outcome technical, not a product defect or an applied receipt', async () => {
  run.mockResolvedValue({ stdout: async () => '', stderr: async () => '' });
  const result = await tool().execute({});
  expect(result).toMatchObject({ success: false });
  expect(result).not.toHaveProperty('code', 'VALIDATION_PRODUCT_FAILURE');
  expect(result).not.toHaveProperty('receipt');
  expect(persist).not.toHaveBeenCalled();
});

it('rechecks ownership before execution and before evidence writes', async () => {
  owner.mockRejectedValueOnce(new Error('stale'));
  await expect(tool().execute({})).rejects.toThrow('stale'); expect(run).not.toHaveBeenCalled();
  owner.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('stale'));
  await expect(tool().execute({})).rejects.toThrow('stale'); expect(persist).not.toHaveBeenCalled();
});

it('redacts runtime-generated sensitive output before persistence and return', async () => {
  const token = randomBytes(24).toString('hex');
  const password = randomBytes(24).toString('hex');
  const username = randomBytes(18).toString('hex');
  const url = new URL('https://example.invalid/validation'); url.username = username; url.password = password;
  url.searchParams.set('token', token);
  run.mockResolvedValue({ exitCode: 1, stdout: async () => `Failed request ${url}`, stderr: async () => '' });
  const result = await tool().execute({});
  for (const secret of [token, password, username]) {
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(persist.mock.calls)).not.toContain(secret);
  }
});