import { describe, expect, it } from '@jest/globals';
import { interpretNpmProbeOutput } from '@/lib/services/sandbox-npm';
import { buildSandboxCreateParams, requirementSandboxTags } from '@/lib/services/sandbox-create-params';
import { requirementSandboxName, sandboxVcpus } from '@/lib/services/sandbox-constants';
import { isInvalidOriginBranchName } from '@/lib/services/sandbox-git-push';

describe('sandbox harness phase 0 / create params', () => {
  it('skips npm when the lockfile hash matches', () => {
    expect(interpretNpmProbeOutput('SKIP abc123')).toBe('skip');
    expect(interpretNpmProbeOutput('INSTALL abc package-lock.json')).toBe('ci');
    expect(interpretNpmProbeOutput('NO_LOCK')).toBe('install');
  });

  it('builds a named persistent create payload with keepLastSnapshots=1', () => {
    const params = buildSandboxCreateParams({
      name: 'req-21c35450-abcd1234',
      tags: requirementSandboxTags('21c35450-xxxx', 'abcd1234-yyyy'),
      coldCreate: true,
    });
    expect(params.name).toBe('req-21c35450-abcd1234');
    expect(params.persistent).toBe(true);
    expect(params.keepLastSnapshots).toEqual({ count: 1, deleteEvicted: true });
    expect((params.tags as { kind: string }).kind).toBe('requirement');
    expect(params.failoverRegions).toEqual(['sfo1']);
    const policy = params.networkPolicy as { allow: string[] | Record<string, unknown> };
    const hosts = Array.isArray(policy.allow) ? policy.allow : Object.keys(policy.allow);
    expect(hosts).toContain('github.com');
  });

  it('does not set failoverRegions on snapshot restore', () => {
    const params = buildSandboxCreateParams({
      snapshotId: 'snap_1',
      coldCreate: false,
    });
    expect(params.failoverRegions).toBeUndefined();
    expect((params.source as { type: string }).type).toBe('snapshot');
  });

  it('names sandboxes req-<8>-<8>', () => {
    expect(requirementSandboxName('21c35450-1234-5678-9abc-def012345678', 'abcd1234-5678-4012-8abc-def012345678'))
      .toBe('req-21c35450-abcd1234');
  });

  it('defaults to 2 vCPUs when SANDBOX_VCPUS is unset', () => {
    const prev = process.env.SANDBOX_VCPUS;
    delete process.env.SANDBOX_VCPUS;
    expect(sandboxVcpus()).toBe(2);
    if (prev === undefined) delete process.env.SANDBOX_VCPUS;
    else process.env.SANDBOX_VCPUS = prev;
  });

  it('rejects HEAD as a push dest', () => {
    expect(isInvalidOriginBranchName('HEAD')).toBe(true);
    expect(isInvalidOriginBranchName('feature/req-abc')).toBe(false);
  });
});
