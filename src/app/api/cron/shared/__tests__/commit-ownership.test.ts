import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';
import { CronExecutionOwnershipError } from '../cron-execution-ownership';

function harness() {
  const assertOwner = jest.fn(async (_input: unknown) => {});
  const build = jest.fn(async () => ({ ok: true }));
  const verifyRestorations = jest.fn(async (_sandbox?: unknown, _entries?: unknown, _committed?: boolean) => {});
  const commitAndPush = jest.fn(async (_sandbox: unknown, options: any) => {
    const error = await options.validateBeforePush?.();
    if (error) throw new Error(error);
    return { branch: 'feature', pushed: true, commitCount: 1 };
  });
  const sandbox: any = {
    extendTimeout: async () => {},
    runCommand: async () => ({ exitCode: 0, stdout: async () => 'head' }),
  };
  const module = loadRuntimeModule<typeof import('../commit/commit-workspace')>(
    'src/app/api/cron/shared/commit/commit-workspace.ts', {
      '@/lib/services/sandbox-service': { SandboxService: { WORK_DIR: '/sandbox',
        ensureFeatureBranchForCron: async () => {}, getCurrentBranch: async () => 'feature', commitAndPush } },
      '@/lib/services/sandbox-sdk': { sandboxIdentity: () => 'sandbox' },
      '@/lib/services/sandbox-git-layout': { assertPlatformGitLayout: async () => {} },
      '../vercel-npm-repo-guard': { validateNpmRepoForVercelDeploy: async () => null },
      '../ensure-preview-frame-ancestors': { ensurePreviewFrameAncestors: async () => {} },
      '@/lib/services/cron-audit-log': { CronInfraEvent: {}, logCronInfrastructureEvent: async () => {} },
      '@/lib/services/requirement-ground-truth': { syncGroundTruthBeforeCommit: async () => {} },
      './status-sync': {},
      '@/lib/services/sandbox-persisted-snapshot': {},
      '@/lib/services/git-push-error-triage': { CommitPushTriageError: class extends Error {}, triageGitPushError: (message: string) => {
        if (/ownership|lease/i.test(message)) throw new Error('Ownership must not be triaged as product failure');
        return { failureKind: 'unknown', agentActionable: false, agentMessage: message };
      } },
      '@/app/api/agents/tools/sandbox/sandbox-source-upload': {},
      './pre-push-build-validation': { ensureApplicationBuildCurrent: build },
      '@/lib/services/sandbox-git-push': { clearStuckGitOperationState: async () => {} },
      '@/lib/services/apps-platform/migration-restoration': { verifyMigrationRestorations: verifyRestorations },
      '../cron-execution-ownership': { assertCronExecutionOwnership: assertOwner,
        isCronExecutionOwnershipError: (error: any) => error?.name === 'CronExecutionOwnershipError' },
    },
  );
  const ownership = { requirementId: 'req', runId: 'run', executionGeneration: 1 };
  const run = (validateDeployment = true, expectedRestorations: any[] = []) => module.commitWorkspaceToOrigin(sandbox, 'Title', 'req', 'Message', undefined, {
    validateDeployment, lightweightCheckpoint: true, executionOwnership: ownership, expectedRestorations,
  });
  return { run, assertOwner, build, commitAndPush, ownership, verifyRestorations, sandbox };
}

describe('commit execution ownership boundaries', () => {
  beforeEach(() => { jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { jest.restoreAllMocks(); });

  it('rechecks ownership after build and at the actual push callback', async () => {
    const h = harness();
    await expect(h.run()).resolves.toMatchObject({ pushed: true });
    expect(h.assertOwner).toHaveBeenCalledTimes(3);
    expect(h.build).toHaveBeenCalledTimes(2);
    expect(h.assertOwner.mock.invocationCallOrder[2]).toBeGreaterThan(h.build.mock.invocationCallOrder[1]);
  });

  it('does not push when ownership was revoked while validating', async () => {
    const h = harness();
    const stale = new CronExecutionOwnershipError('run_owner_changed');
    h.assertOwner.mockResolvedValueOnce(undefined).mockRejectedValueOnce(stale);
    await expect(h.run()).rejects.toBe(stale);
    expect(h.commitAndPush).not.toHaveBeenCalled();
  });

  it('guards even lightweight artifact pushes which do not require a build', async () => {
    const h = harness();
    const stale = new CronExecutionOwnershipError('lease_expired');
    h.assertOwner.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(stale);
    await expect(h.run(false)).rejects.toBe(stale);
    expect(h.build).not.toHaveBeenCalled();
  });

  it('verifies restored worktree then committed bytes after build and lease validation', async () => {
    const h = harness();
    const receipts = [{ file: 'supabase/migrations/001.sql', checksum: 'a'.repeat(64) }];
    await expect(h.run(true, receipts)).resolves.toMatchObject({ pushed: true });
    expect(h.verifyRestorations.mock.calls).toEqual([
      [h.sandbox, receipts], [h.sandbox, receipts, true], [h.sandbox, receipts, true],
    ]);
    expect(h.verifyRestorations.mock.invocationCallOrder[1]).toBeGreaterThan(h.assertOwner.mock.invocationCallOrder[2]);
  });

  it('rechecks each push candidate after a rebase rather than trusting the earlier restoration', async () => {
    const h = harness();
    let candidateAccepted = false;
    h.commitAndPush.mockImplementation(async (_sandbox, options) => {
      await options.validateBeforePush();
      h.verifyRestorations.mockRejectedValueOnce(new Error('restored commit changed'));
      await options.validateBeforePush();
      candidateAccepted = true;
      return { branch: 'feature', pushed: true, commitCount: 1 };
    });
    await expect(h.run(false, [{ file: 'supabase/migrations/001.sql' }])).rejects.toThrow();
    expect(candidateAccepted).toBe(false);
    expect(h.verifyRestorations).toHaveBeenCalledTimes(3);
  });

  it('verifies HEAD even when the clean checkpoint shortcut did not push', async () => {
    const h = harness();
    h.commitAndPush.mockResolvedValue({ branch: 'feature', pushed: false, commitCount: 0 });
    const receipts = [{ file: 'supabase/migrations/001.sql' }];
    await expect(h.run(false, receipts)).resolves.toMatchObject({ pushed: false });
    expect(h.verifyRestorations).toHaveBeenLastCalledWith(h.sandbox, receipts, true);
    expect(h.verifyRestorations).toHaveBeenCalledTimes(2);
  });
});