import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function loadRuntimeModule<T>(relativePath: string, dependencies: Record<string, unknown>): T {
  const filename = path.resolve(process.cwd(), relativePath);
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  runInNewContext(code, {
    module, exports: module.exports, console,
    process: { env: { GITHUB_TOKEN: syntheticToken } },
    require: (specifier: string) => {
      if (!(specifier in dependencies)) throw new Error(`Unmocked dependency: ${specifier}`);
      return dependencies[specifier];
    },
  }, { filename });
  return module.exports as T;
}

const named = jest.fn();
const create = jest.fn();
const sync = jest.fn();
const clone = jest.fn();
const persist = jest.fn();
const branch = jest.fn();
const assertLayout = jest.fn();
const assertOwner = jest.fn();
const syntheticToken = randomBytes(24).toString('hex');
const binding = { kind: 'applications', org: 'example', repo: 'app', default_branch: 'main' };
const { createRequirementSandbox } = loadRuntimeModule<typeof import('../sandbox-provision')>(
  'src/lib/services/sandbox-provision.ts', {
    '@vercel/sandbox': { Sandbox: { create } },
    '@/lib/services/cron-audit-log': { CronInfraEvent: {}, logCronInfrastructureEvent: jest.fn() },
    '@/lib/services/sandbox-git-layout': { assertPlatformGitLayout: assertLayout },
    '@/lib/services/requirement-git-binding': { getRequirementGitBinding: async () => binding, resolveDefaultGitBinding: () => binding },
    '@/lib/tools/requirement-status-core': { persistActiveSandboxId: persist },
    '@/lib/services/sandbox-sdk': { sandboxIdentity: () => 'req-existing', sandboxSdkMajor: () => 3 },
    '@/lib/services/sandbox-constants': { SANDBOX_WORK_DIR: '/vercel/sandbox', requirementSandboxName: () => 'req-existing' },
    '@/lib/services/sandbox-stop': { stopSandboxQuiet: jest.fn() },
    '@/lib/services/sandbox-npm': { ensureNpmDeps: jest.fn() },
    '@/lib/services/sandbox-git-identity': { fetchOriginBranch: jest.fn(), installGitIdentity: jest.fn() },
    '@/lib/services/sandbox-create-params': { buildSandboxCreateParams: jest.fn(), requirementSandboxTags: () => ({ kind: 'requirement' }) },
    '@/lib/services/sandbox-get-or-create': { getOrCreateRequirementSandbox: named },
    '@/lib/services/sandbox-git-clone': { cloneRepoIntoWorkDir: clone },
    '@/lib/services/sandbox-service': { SandboxService: { getCurrentBranch: branch, syncTrackedBranchToRemoteTip: sync } },
    '@/app/api/cron/shared/cron-execution-ownership': { assertCronExecutionOwnership: assertOwner },
  },
);

describe('named provision preservation', () => {
  const audit = { siteId: 'site', instanceId: 'instance', requirementId: 'req', executionOwnership: { requirementId: 'req', runId: 'run', executionGeneration: 1 } };
  beforeEach(() => {
    jest.resetAllMocks();
    branch.mockResolvedValue('feature/req-existing');
    persist.mockResolvedValue(undefined);
    assertOwner.mockResolvedValue(undefined);
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns reused VM/branch without cold checkout, reset, clone or create', async () => {
    const sandbox = { runCommand: jest.fn() };
    named.mockResolvedValue({ sandbox, created: false });
    await expect(createRequirementSandbox('req', 'applications', '', audit)).resolves.toEqual({
      sandbox, branchName: 'feature/req-existing', workDir: '/vercel/sandbox', isNewBranch: false, instanceType: 'applications',
    });
    expect(assertLayout).toHaveBeenCalledWith(sandbox);
    expect(sandbox.runCommand).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
    expect(clone).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    await named.mock.calls[0][0].assertRecoveryOwnership();
    expect(assertOwner).toHaveBeenCalledWith(audit.executionOwnership);
  });

  it('propagates named errors without fork/create fallback', async () => {
    const error = new Error('resume unavailable');
    named.mockRejectedValue(error);
    await expect(createRequirementSandbox('req', 'applications', '', audit)).rejects.toBe(error);
    expect(create).not.toHaveBeenCalled();
    expect(clone).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });
});