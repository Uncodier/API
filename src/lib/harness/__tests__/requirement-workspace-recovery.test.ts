import { randomUUID } from 'node:crypto';
import { openRequirementWorkspace } from '../requirement-workspace-recovery';
import { WorkspaceError } from '../workspace';
import type { Workspace } from '../types';

jest.mock('@vercel/sandbox', () => ({ Sandbox: { get: jest.fn(), create: jest.fn() } }));

function fixture() {
  const sessionId = randomUUID();
  const workspace = { ref: { provider: 'vercel', id: `h-${sessionId}`, root: '/vercel/sandbox' } } as Workspace;
  const input = { sessionId, siteId: randomUUID(), repository: { url: 'https://repo.example.invalid/project.git', ref: 'main' },
    existingWorkspace: 'req-legacy', existing: workspace.ref, assertActive: jest.fn().mockResolvedValue(undefined),
    cleanupCreated: jest.fn(), onOwnedHandle: jest.fn(), onMissingWorkspace: jest.fn().mockResolvedValue(undefined),
    signal: new AbortController().signal };
  const dependencies = { adopt: jest.fn().mockResolvedValue(workspace), open: jest.fn().mockResolvedValue(workspace) };
  return { input, dependencies, workspace };
}

it('preserves an available workspace without clone or branch switch', async () => {
  const f = fixture();
  expect(await openRequirementWorkspace(f.input, f.dependencies)).toEqual({ workspace: f.workspace, selectBranch: false });
  expect(f.dependencies.open).not.toHaveBeenCalled();
});

it('reprovisions a missing legacy workspace through the normal session-scoped opener', async () => {
  const f = fixture();
  f.dependencies.adopt.mockRejectedValue(new WorkspaceError('WORKSPACE_NOT_FOUND', 'missing'));
  expect(await openRequirementWorkspace(f.input, f.dependencies)).toEqual({ workspace: f.workspace,
    selectBranch: true, recoveredFrom: 'req-legacy' });
  expect(f.input.assertActive).toHaveBeenCalled();
  expect(f.input.onMissingWorkspace).toHaveBeenCalledWith('req-legacy');
  expect(f.input.onMissingWorkspace.mock.invocationCallOrder[0]).toBeLessThan(f.dependencies.open.mock.invocationCallOrder[0]);
  expect(f.dependencies.open).toHaveBeenCalledTimes(1);
  expect(f.dependencies.open).toHaveBeenCalledWith(expect.objectContaining({ sessionId: f.input.sessionId,
    repository: f.input.repository, existing: undefined, signal: f.input.signal,
    cleanupCreated: f.input.cleanupCreated, onOwnedHandle: f.input.onOwnedHandle }));
});

it.each(['WORKSPACE_AUTHORIZATION_REQUIRED', 'WORKSPACE_PROVIDER_BILLING_REQUIRED', 'WORKSPACE_OPEN_FAILED',
  'WORKSPACE_SCOPE_MISMATCH', 'WORKSPACE_SNAPSHOT_MISSING'])('does not replace on %s', async code => {
  const f = fixture();
  const error = new WorkspaceError(code, 'failure');
  f.dependencies.adopt.mockRejectedValue(error);
  await expect(openRequirementWorkspace(f.input, f.dependencies)).rejects.toBe(error);
  expect(f.dependencies.open).not.toHaveBeenCalled();
});

it('does not recreate after cancellation or ownership loss', async () => {
  for (const cancelled of [true, false]) {
    const f = fixture();
    f.dependencies.adopt.mockRejectedValue(new WorkspaceError('WORKSPACE_NOT_FOUND', 'missing'));
    const controller = new AbortController(); f.input.signal = controller.signal;
    if (cancelled) controller.abort();
    else f.input.assertActive.mockRejectedValue(new Error('lost owner'));
    await expect(openRequirementWorkspace(f.input, f.dependencies)).rejects.toThrow();
    expect(f.dependencies.open).not.toHaveBeenCalled();
  }
});

it('does not retry an ambiguous creation failure', async () => {
  const f = fixture();
  f.dependencies.adopt.mockRejectedValue(new WorkspaceError('WORKSPACE_NOT_FOUND', 'missing'));
  const error = new Error('creation receipt unavailable');
  f.dependencies.open.mockRejectedValue(error);
  await expect(openRequirementWorkspace(f.input, f.dependencies)).rejects.toBe(error);
  expect(f.dependencies.open).toHaveBeenCalledTimes(1);
});

it('requires durable reference retirement before creating a billed replacement', async () => {
  const f = fixture();
  f.dependencies.adopt.mockRejectedValue(new WorkspaceError('WORKSPACE_NOT_FOUND', 'missing'));
  f.input.onMissingWorkspace.mockRejectedValue(new Error('save failed'));
  await expect(openRequirementWorkspace(f.input, f.dependencies)).rejects.toThrow('save failed');
  expect(f.dependencies.open).not.toHaveBeenCalled();
  await expect(openRequirementWorkspace({ ...f.input, onMissingWorkspace: undefined }, f.dependencies))
    .rejects.toThrow('durable host callback');
  expect(f.dependencies.open).not.toHaveBeenCalled();
});

it('uses normal provisioning for first admission', async () => {
  const f = fixture();
  expect(await openRequirementWorkspace({ ...f.input, existingWorkspace: undefined, existing: undefined }, f.dependencies))
    .toEqual({ workspace: f.workspace, selectBranch: true });
  expect(f.dependencies.adopt).not.toHaveBeenCalled();
});

it('finishes branch selection when a canonical replacement exists but its reference was not yet saved', async () => {
  const f = fixture();
  expect(await openRequirementWorkspace({ ...f.input, existing: undefined,
    existingWorkspace: `h-${f.input.sessionId}` }, f.dependencies))
    .toEqual({ workspace: f.workspace, selectBranch: true });
  expect(f.dependencies.open).not.toHaveBeenCalled();
});