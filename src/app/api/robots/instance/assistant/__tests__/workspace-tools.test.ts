import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { assertToolScreenAccess } from '@/app/api/agents/tools/router/screen-access';
import { resolveAssistantWorkspaceSource } from '../workspace-source';
import { openAssistantWorkspace } from '../workspace-provider';
import { createAssistantWorkspaceTools } from '../workspace-tools';
import { WorkspaceError } from '@/lib/harness/workspace';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc: jest.fn() } }));
jest.mock('@vercel/sandbox', () => ({ Sandbox: {} }));
jest.mock('@/app/api/agents/tools/router/screen-access', () => ({
  ...jest.requireActual('@/app/api/agents/tools/router/screen-access'), assertToolScreenAccess: jest.fn(async () => {}),
}));
jest.mock('../workspace-source', () => ({ resolveAssistantWorkspaceSource: jest.fn() }));
jest.mock('../workspace-provider', () => ({ openAssistantWorkspace: jest.fn(), AssistantWorkspaceOpenError: class extends Error {} }));
const scope = { instanceId: randomUUID(), siteId: randomUUID(), userId: randomUUID() };
const assertActive = jest.fn(async () => {});
let close: jest.Mock, readFile: jest.Mock, exec: jest.Mock;
beforeEach(() => {
  jest.clearAllMocks();
  (resolveAssistantWorkspaceSource as jest.Mock).mockResolvedValue({ kind: 'instance' });
  (supabaseAdmin.rpc as jest.Mock).mockImplementation(async name => ({ data: name === 'claim_assistant_workspace' ? { initialized: false } : true, error: null }));
  close = jest.fn(async () => {});
  readFile = jest.fn(async () => 'Existing implementation\nTests passed');
  exec = jest.fn(async () => ({ stdout: '{"entries":[{"path":"src"}],"truncated":false,"ok":true}', stderr: '', exitCode: 0 }));
  (openAssistantWorkspace as jest.Mock).mockResolvedValue({ close, source: { kind: 'instance_workspace' },
    workspace: { ref: { id: `a-${scope.instanceId}`, provider: 'vercel', root: '/vercel/sandbox' }, readFile, exec } });
});
const call = (name: string, args: any) => createAssistantWorkspaceTools(scope, assertActive).find(tool => tool.name === name)!.execute(args);

it('exposes the shared filesystem catalog without connecting or provisioning', () => {
  expect(createAssistantWorkspaceTools(scope, assertActive).map(tool => tool.name)).toEqual([
    'read_files', 'list_files', 'search', 'apply_patch', 'exec', 'process_status', 'process_stop',
  ]);
  expect(openAssistantWorkspace).not.toHaveBeenCalled();
  expect(supabaseAdmin.rpc).not.toHaveBeenCalled();
  expect(assertToolScreenAccess).not.toHaveBeenCalled();
});

it('connects only when a file tool is called and uses real shared read implementation', async () => {
  const result = await call('read_files', { files: [{ path: 'README.md' }], thought_process: 'Inspect files' });
  expect(result).toMatchObject({ ok: true, output: { files: [{ content: 'Existing implementation\nTests passed' }] }, workspace_source: { kind: 'instance_workspace' } });
  expect(readFile).toHaveBeenCalledWith('README.md', expect.any(AbortSignal));
  expect(openAssistantWorkspace).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
  expect(supabaseAdmin.rpc).toHaveBeenCalledWith('release_assistant_workspace', expect.objectContaining({ p_instance_id: scope.instanceId, p_site_id: scope.siteId }));
});

it('reads a managed snapshot without resuming or mutating its requirement', async () => {
  (resolveAssistantWorkspaceSource as jest.Mock).mockResolvedValue({ kind: 'requirement', requirementId: randomUUID(), sandboxName: 'saved' });
  expect(await call('list_files', {})).toMatchObject({ ok: true, output: { entries: [{ path: 'src' }] } });
  expect((supabaseAdmin.rpc as jest.Mock).mock.calls.every(([name]) => /assistant_workspace$/.test(name))).toBe(true);
});

it.each(['exec', 'apply_patch', 'process_stop'])('does not dispatch %s against a requirement-owned workspace', async name => {
  (resolveAssistantWorkspaceSource as jest.Mock).mockResolvedValue({ kind: 'requirement', requirementId: randomUUID(), sandboxName: 'saved' });
  const args = name === 'exec' ? { command: 'echo safe' } : name === 'apply_patch'
    ? { changes: [{ operation: 'create', path: 'file.md', content: 'text' }] } : { processId: 'id' };
  expect(await call(name, args)).toMatchObject({ success: false, executed: false, error: { code: 'WORKSPACE_OWNER_REQUIRED' } });
  expect(openAssistantWorkspace).not.toHaveBeenCalled();
  expect(supabaseAdmin.rpc).not.toHaveBeenCalled();
});

it.each([{ path: '../foreign' }, { path: '.env.local' }, { limit: -1 }])('rejects invalid arguments before provisioning: %j', async args => {
  expect(await call('list_files', args)).toMatchObject({ executed: false, error: { code: 'INVALID_WORKSPACE_ARGUMENTS' } });
  expect(openAssistantWorkspace).not.toHaveBeenCalled();
  expect(supabaseAdmin.rpc).not.toHaveBeenCalled();
});

it('never opens without its lease or after cancellation', async () => {
  (supabaseAdmin.rpc as jest.Mock).mockResolvedValueOnce({ data: null, error: null });
  expect(await call('list_files', {})).toMatchObject({ error: { code: 'WORKSPACE_BUSY' } });
  expect(openAssistantWorkspace).not.toHaveBeenCalled();
  assertActive.mockRejectedValueOnce(Object.assign(new Error('inactive'), { name: 'RecoveryError' }));
  await expect(call('list_files', {})).rejects.toMatchObject({ name: 'RecoveryError' });
});

it('does not treat missing migration or DB outage as permission for an unbilled VM', async () => {
  (supabaseAdmin.rpc as jest.Mock).mockResolvedValueOnce({ data: null, error: { message: 'Missing function' } });
  expect(await call('list_files', {})).toMatchObject({ error: { code: 'WORKSPACE_LEASE_UNAVAILABLE' } });
  expect(openAssistantWorkspace).not.toHaveBeenCalled();
});

it('retains the lease for timeout recovery when cleanup is unconfirmed', async () => {
  close.mockRejectedValue(new Error('unknown stop'));
  await call('read_files', { files: [{ path: 'README.md' }] });
  expect((supabaseAdmin.rpc as jest.Mock).mock.calls.some(([name]) => name === 'release_assistant_workspace')).toBe(false);
});

it('releases a lease after a missing source snapshot before any copy could start', async () => {
  (openAssistantWorkspace as jest.Mock).mockRejectedValueOnce(new WorkspaceError('WORKSPACE_SNAPSHOT_UNAVAILABLE', 'No saved snapshot', false));
  expect(await call('list_files', {})).toMatchObject({ error: { code: 'WORKSPACE_SNAPSHOT_UNAVAILABLE' } });
  expect((supabaseAdmin.rpc as jest.Mock).mock.calls.some(([name]) => name === 'release_assistant_workspace')).toBe(true);
});