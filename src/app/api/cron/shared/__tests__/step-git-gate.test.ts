jest.mock('@/lib/services/robot-instance/assistant-executor', () => ({ executeAssistantStep: jest.fn() }));
jest.mock('@/lib/services/sandbox-service', () => ({ SandboxService: { WORK_DIR: '/vercel/sandbox' } }));
jest.mock('../cron-commit-helpers', () => ({
  commitWorkspaceToOrigin: jest.fn(),
  resolveGitBindingForRequirement: jest.fn(),
  syncLatestRequirementStatusWithPreview: jest.fn(),
}));
jest.mock('@/lib/services/github-deployment-status', () => ({
  fetchGitHubBranchTipSha: jest.fn(), pollGitHubDeploymentForSha: jest.fn(),
}));
jest.mock('@/lib/services/vercel-build-logs', () => ({ fetchAndLogVercelBuildLog: jest.fn() }));
jest.mock('@/lib/services/cron-audit-log', () => ({
  CronInfraEvent: { GATE_BUILD: 'build', GATE_ORIGIN: 'origin', STEP_STATUS: 'status', GATE_PUSH_RECOVERY: 'recovery' },
  logCronInfrastructureEvent: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../step-gate-probes', () => ({ runRuntimeAndVisualProbes: jest.fn() }));
jest.mock('../step-interaction-runner', () => ({ runInteractionAudit: jest.fn() }));
jest.mock('../step-interaction-backlog', () => ({ applyInteractionBacklogPolicy: jest.fn() }));
jest.mock('../vercel-npm-repo-guard', () => ({ validateNpmRepoForVercelDeploy: jest.fn().mockResolvedValue(null) }));
// Do not load the dispatcher (or its generated workflow bundle) via re-exports.
jest.mock('../gates', () => ({ runGateForFlow: jest.fn() }));

import { executeAssistantStep } from '@/lib/services/robot-instance/assistant-executor';
import { fetchGitHubBranchTipSha, pollGitHubDeploymentForSha } from '@/lib/services/github-deployment-status';
import { commitWorkspaceToOrigin } from '../cron-commit-helpers';
import { runRuntimeAndVisualProbes } from '../step-gate-probes';
import { runInteractionAudit } from '../step-interaction-runner';
import { applyInteractionBacklogPolicy } from '../step-interaction-backlog';
import { MAX_PUSH_RECOVERY_TURNS, runBuildAndOriginGate } from '../step-git-gate';
import { selectReusableGateValidation } from '../gate-validation-cache';
import { buildGateErrorFeedback, isEvidenceCollectionRetry } from '../single-turn-helpers';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const branch = 'feature/requirement';
const commandResult = (exitCode: number, stdout = '') => ({
  exitCode, stdout: async () => stdout, stderr: async () => '',
});

function sandboxFixture() {
  const sandbox = {
    fingerprint: A as string | null,
    unreadableFingerprint: false,
    runCommand: jest.fn(async (command: string, args: string[]): Promise<ReturnType<typeof commandResult>> => {
      if (command === 'node') {
        if (sandbox.unreadableFingerprint) throw new Error('fingerprint output unreadable');
        return commandResult(sandbox.fingerprint ? 0 : 1, sandbox.fingerprint || '');
      }
      if (command === 'sh' && args[1].includes('npm test')) return commandResult(0, 'PASS');
      return commandResult(0);
    }),
    writeFiles: jest.fn().mockResolvedValue(undefined),
  };
  return sandbox;
}

function input(sandbox = sandboxFixture()): Parameters<typeof runBuildAndOriginGate>[0] {
  return {
    sandbox: sandbox as any, planTitle: 'QA plan', requirementId: '11111111-1111-4111-8111-111111111111',
    stepId: 'step-1', stepOrder: 1, stepPrompt: 'Validate feature',
    stepContext: { title: 'QA step', test_command: 'npm test' },
    currentMessages: [], context: { instance: {}, executionOptions: {} } as any,
    fullTools: [], lastResult: { messages: [] }, validateDeployment: false,
  };
}

function countCommands(sandbox: ReturnType<typeof sandboxFixture>, fragment: string) {
  return sandbox.runCommand.mock.calls.filter(([command, args]) => command === 'sh' && args[1].includes(fragment)).length;
}

function expectInvalidated(result: Awaited<ReturnType<typeof runBuildAndOriginGate>>, fingerprint: string | undefined) {
  expect(result).toMatchObject({ ok: false, signals: {
    workspace_fingerprint: fingerprint,
    build: { ok: false },
    tests: { ok: false, tests: [expect.objectContaining({ exit_code: 0, ran_after_changes: false, workspace_fingerprint: A })] },
  } });
  for (const key of ['runtime', 'api', 'console', 'visual', 'scenarios', 'observations', 'interaction', 'deploy']) {
    expect(result.signals).not.toHaveProperty(key);
  }
  expect(fetchGitHubBranchTipSha).not.toHaveBeenCalled();
  expect(pollGitHubDeploymentForSha).not.toHaveBeenCalled();
  expect(selectReusableGateValidation({
    stepId: 'step-1', workspaceFingerprint: fingerprint, testCommand: 'npm test',
    evidence: {
      producer_step_id: 'step-1', workspace_fingerprint: fingerprint,
      build: { exit_code: result.signals.build?.ok ? 0 : 1 }, tests: result.signals.tests?.tests,
    } as any,
  })).toBeUndefined();
}

describe('build and origin gate final-tree evidence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (commitWorkspaceToOrigin as jest.Mock).mockResolvedValue({ pushed: true, branch });
    (executeAssistantStep as jest.Mock).mockResolvedValue({ messages: [], recovered: true });
    (runInteractionAudit as jest.Mock).mockResolvedValue({ ok: true, summary: 'No blockers', findings: [] });
    (applyInteractionBacklogPolicy as jest.Mock).mockImplementation(async ({ signal }) => signal);
    (runRuntimeAndVisualProbes as jest.Mock).mockResolvedValue({ ok: true, signals: {
      runtime: { ok: true, pages: [], server_errors: [] },
      api: { ok: true, apis: [] },
      console: { ok: true, entries: [], page_errors: [], failed_requests: [] },
      visual: { ok: true }, scenarios: { ok: true, scenarios: [] },
      observations: [{ kind: 'page', disposition: 'pass', source: 'contract', target: '/', detail: 'HTTP 200' }],
    } });
  });

  it('passes when actual local build/tests and probes still match the final tree', async () => {
    const sandbox = sandboxFixture();
    const result = await runBuildAndOriginGate(input(sandbox));
    expect(result).toMatchObject({ ok: true, signals: {
      workspace_fingerprint: A, build: { ok: true }, tests: { ok: true },
      runtime: { ok: true }, origin: { ok: true, branch },
    } });
    expect(countCommands(sandbox, 'npm run build')).toBe(1);
    expect(countCommands(sandbox, 'npm test')).toBe(1);
    expect(runRuntimeAndVisualProbes).toHaveBeenCalledTimes(1);
    expect(executeAssistantStep).not.toHaveBeenCalled();
  });

  it('does not repeat validation when recovery only repairs git metadata', async () => {
    (commitWorkspaceToOrigin as jest.Mock).mockResolvedValueOnce({ pushed: false, branch });
    const sandbox = sandboxFixture();
    const result = await runBuildAndOriginGate(input(sandbox));
    expect(result.ok).toBe(true);
    expect(result.lastResult.recovered).toBe(true);
    expect(executeAssistantStep).toHaveBeenCalledTimes(1);
    expect(countCommands(sandbox, 'npm test')).toBe(1);
  });

  it.each(['final', 'intermediate'] as const)('rejects stale %s evidence when assistant recovery edits product code', async (validationScope) => {
    const sandbox = sandboxFixture();
    (commitWorkspaceToOrigin as jest.Mock).mockResolvedValueOnce({ pushed: false, branch });
    (executeAssistantStep as jest.Mock).mockImplementationOnce(async () => {
      sandbox.fingerprint = B;
      return { messages: [], recovered: true };
    });
    const result = await runBuildAndOriginGate({ ...input(sandbox), validationScope, validateDeployment: true });
    expectInvalidated(result, B);
    expect(result).toMatchObject({ failureKind: 'evidence_gap', infrastructureFailure: false });
    const feedback = buildGateErrorFeedback({
      gate: { ...result, flow: 'app', signals: [], richSignals: result.signals },
      step: { order: 1 }, persistedStep: { retry_count: 0 },
    });
    expect(isEvidenceCollectionRetry(feedback.excerpt)).toBe(true);
    expect(executeAssistantStep).toHaveBeenCalledTimes(1);
    expect(commitWorkspaceToOrigin).toHaveBeenCalledTimes(2);
    expect(countCommands(sandbox, 'npm run build')).toBe(1);
    expect(countCommands(sandbox, 'npm test')).toBe(1);
  });

  it('rejects mutation inside deterministic origin persistence without assistant recovery', async () => {
    const sandbox = sandboxFixture();
    (commitWorkspaceToOrigin as jest.Mock).mockImplementationOnce(async () => {
      sandbox.fingerprint = B;
      return { pushed: true, branch };
    });
    expectInvalidated(await runBuildAndOriginGate(input(sandbox)), B);
    expect(executeAssistantStep).not.toHaveBeenCalled();
  });

  it('invalidates reused receipts after origin mutation without rewriting the cached evidence', async () => {
    const sandbox = sandboxFixture();
    const cachedTests = {
      ok: true,
      tests: [{ command: 'npm test', exit_code: 0, output_tail: 'PASS', ran_after_changes: true,
        captured_at: '2026-09-26T00:00:00.000Z', step_id: 'step-1', workspace_fingerprint: A }],
    };
    (commitWorkspaceToOrigin as jest.Mock).mockImplementationOnce(async () => {
      sandbox.fingerprint = B;
      return { pushed: true, branch };
    });
    const result = await runBuildAndOriginGate({
      ...input(sandbox), workspaceFingerprint: A,
      reusableValidation: { buildPassed: true, tests: cachedTests },
    });
    expectInvalidated(result, B);
    expect(countCommands(sandbox, 'npm run build')).toBe(0);
    expect(countCommands(sandbox, 'npm test')).toBe(0);
    expect(cachedTests.ok).toBe(true);
    expect(cachedTests.tests[0].ran_after_changes).toBe(true);
  });

  it.each([A, B])('fingerprints the replacement sandbox (%s), not its stopped predecessor', async (fingerprint) => {
    const sandbox = sandboxFixture();
    const replacement = sandboxFixture();
    replacement.fingerprint = fingerprint;
    (commitWorkspaceToOrigin as jest.Mock).mockImplementationOnce(async () => {
      sandbox.unreadableFingerprint = true;
      return { pushed: true, branch, sandboxReplacement: replacement };
    });
    const params = input(sandbox);
    const result = await runBuildAndOriginGate(params);
    expect(result.sandboxReplacement).toBe(replacement);
    expect(params.sandbox).toBe(sandbox);
    expect(replacement.runCommand).toHaveBeenCalledWith('node', expect.any(Array));
    if (fingerprint === B) expectInvalidated(result, B);
    else expect(result.ok).toBe(true);
  });

  it.each(['missing', 'unreadable'])('fails closed when the final fingerprint is %s', async (mode) => {
    const sandbox = sandboxFixture();
    (commitWorkspaceToOrigin as jest.Mock).mockImplementationOnce(async () => {
      if (mode === 'missing') sandbox.fingerprint = null;
      else sandbox.unreadableFingerprint = true;
      return { pushed: true, branch };
    });
    const result = await runBuildAndOriginGate(input(sandbox));
    expectInvalidated(result, undefined);
    expect(result).toMatchObject({ failureKind: 'infrastructure_unavailable', infrastructureFailure: true });
  });

  it('detects probe mutation even when there is no origin to verify', async () => {
    const sandbox = sandboxFixture();
    (runRuntimeAndVisualProbes as jest.Mock).mockImplementationOnce(async () => {
      sandbox.fingerprint = B;
      return { ok: true, signals: {} };
    });
    expectInvalidated(await runBuildAndOriginGate({ ...input(sandbox), requirementId: '' }), B);
    expect(commitWorkspaceToOrigin).not.toHaveBeenCalled();
  });

  it('never recursively revalidates or extends the existing recovery-turn bound', async () => {
    const sandbox = sandboxFixture();
    (commitWorkspaceToOrigin as jest.Mock).mockResolvedValue({ pushed: false, branch });
    (executeAssistantStep as jest.Mock).mockImplementation(async () => {
      sandbox.fingerprint = B;
      return { messages: [] };
    });
    const result = await runBuildAndOriginGate(input(sandbox));
    expectInvalidated(result, B);
    expect(executeAssistantStep).toHaveBeenCalledTimes(MAX_PUSH_RECOVERY_TURNS);
    expect(commitWorkspaceToOrigin).toHaveBeenCalledTimes(MAX_PUSH_RECOVERY_TURNS + 1);
    expect(countCommands(sandbox, 'npm test')).toBe(1);
  });

  it('a bounded retry validates new files instead of reusing their old passing receipts', async () => {
    const sandbox = sandboxFixture();
    (commitWorkspaceToOrigin as jest.Mock).mockImplementationOnce(async () => {
      sandbox.fingerprint = B;
      return { pushed: true, branch };
    });
    expectInvalidated(await runBuildAndOriginGate(input(sandbox)), B);
    const result = await runBuildAndOriginGate(input(sandbox));
    expect(result).toMatchObject({ ok: true, signals: {
      workspace_fingerprint: B,
      tests: { ok: true, tests: [expect.objectContaining({ workspace_fingerprint: B, ran_after_changes: true })] },
    } });
    expect(countCommands(sandbox, 'npm run build')).toBe(2);
    expect(countCommands(sandbox, 'npm test')).toBe(2);
    expect(runRuntimeAndVisualProbes).toHaveBeenCalledTimes(2);
  });
});