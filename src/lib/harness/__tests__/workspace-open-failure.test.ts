import { randomBytes, randomUUID } from 'node:crypto';
import { Sandbox } from '@vercel/sandbox';
import { openWorkspace, adoptRequirementWorkspace } from '../workspace';
import { workspaceOpenFailure, workspaceOpenRequiresOperator } from '../workspace-open-failure';
jest.mock('@vercel/sandbox', () => ({ Sandbox: { get: jest.fn(), create: jest.fn() } }));
beforeEach(() => jest.resetAllMocks());
it.each([401, 402, 403])('retains provider HTTP %s on cold and existing workspace opening without leaking SDK payloads', async status => {
  const token = randomBytes(24).toString('hex');
  const failure = Object.assign(new Error(token), { response: { status }, json: { token } });
  (Sandbox.get as jest.Mock).mockRejectedValue(failure);
  const input = { sessionId: randomUUID(), repository: { url: 'https://repo.example.invalid/project.git' }, assertActive: async () => {} };
  for (const operation of [() => openWorkspace(input), () => adoptRequirementWorkspace({ ...input, workspaceId: 'owned-existing' })]) {
    const result = await operation().catch(error => error);
    expect(result.name).toBe('WorkspaceError'); expect(result.message).toContain(`HTTP ${status}`);
    expect(result.message).not.toContain(token); expect(workspaceOpenRequiresOperator(result)).toBe(true);
  }
  expect(Sandbox.create).not.toHaveBeenCalled();
});
it.each([404, 429, 500, 503])('does not misclassify transient/unavailable HTTP %s as operator authorization', status => {
  expect(workspaceOpenFailure({ response: { status } }).operatorRequired).toBe(false);
});
it('handles the SDK alternate response shape without inferring status from untrusted text', () => {
  expect(workspaceOpenFailure({ response: { statusCode: 403 } }).code).toBe('WORKSPACE_AUTHORIZATION_REQUIRED');
  expect(workspaceOpenFailure(new Error('403')).operatorRequired).toBe(false);
});
it('classifies provider billing rejection during creation after a confirmed missing VM', async () => {
  (Sandbox.get as jest.Mock).mockRejectedValue({ response: { status: 404 } });
  (Sandbox.create as jest.Mock).mockRejectedValue({ response: { status: 402 } });
  await expect(openWorkspace({ sessionId: randomUUID(), repository: { url: 'https://repo.example.invalid/project.git' } }))
    .rejects.toMatchObject({ code: 'WORKSPACE_PROVIDER_BILLING_REQUIRED' });
  expect(Sandbox.create).toHaveBeenCalledTimes(1);
});