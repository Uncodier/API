import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { guardToolScreen } from '@/app/api/agents/tools/router/screen-access';
import { createAssistantWorkspaceTools } from '../workspace-tools';
import { openAssistantWorkspace } from '../workspace-provider';
import { resolveAssistantWorkspaceSource } from '../workspace-source';

jest.mock('@vercel/sandbox', () => ({ Sandbox: {} }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn(), rpc: jest.fn() } }));
jest.mock('../workspace-source', () => ({ resolveAssistantWorkspaceSource: jest.fn() }));
jest.mock('../workspace-provider', () => ({ openAssistantWorkspace: jest.fn(), AssistantWorkspaceOpenError: class extends Error {} }));

const scope = { instanceId: randomUUID(), siteId: randomUUID(), userId: randomUUID() };
let permissionRead: jest.Mock, readFile: jest.Mock, close: jest.Mock;
beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  permissionRead = jest.fn(async () => ({ data: true, error: null, status: 200 }));
  (supabaseAdmin.rpc as jest.Mock).mockImplementation((name: string) => {
    if (name === 'site_user_has_effective_access') return { abortSignal: permissionRead };
    return Promise.resolve({ data: name === 'claim_assistant_workspace' ? { initialized: false } : true, error: null });
  });
  (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
    if (table !== 'sites') throw new Error('A canonical owner does not need role queries');
    const query: any = {};
    for (const method of ['select', 'eq', 'abortSignal']) query[method] = () => query;
    query.maybeSingle = async () => ({ data: { user_id: scope.userId }, error: null, status: 200 });
    return query;
  });
  (resolveAssistantWorkspaceSource as jest.Mock).mockResolvedValue({ kind: 'requirement', requirementId: randomUUID(), sandboxName: 'saved-source' });
  readFile = jest.fn(async () => 'Persisted report'); close = jest.fn(async () => {});
  (openAssistantWorkspace as jest.Mock).mockImplementation(async input => {
    await input.assertActive();
    return { workspace: { ref: { id: 'private-inspection', provider: 'vercel', root: '/vercel/sandbox' }, readFile },
      source: { kind: 'requirement_snapshot' }, close };
  });
});
afterEach(() => jest.restoreAllMocks());

function tool() {
  const read = createAssistantWorkspaceTools(scope, async () => {}).find(tool => tool.name === 'read_files')!;
  return guardToolScreen(read, { siteId: scope.siteId, userId: scope.userId });
}

it('retries only the initial transient authorization and reads the workspace exactly once', async () => {
  permissionRead.mockResolvedValueOnce({ data: null, error: { code: '57014' }, status: 500 });
  expect(await tool().execute({ files: [{ path: 'report.md' }] })).toMatchObject({ ok: true,
    output: { files: [{ path: 'report.md', content: 'Persisted report' }] } });
  expect(openAssistantWorkspace).toHaveBeenCalledTimes(1);
  expect(readFile).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
  expect(console.warn).toHaveBeenCalledTimes(1);
  expect(console.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ attempt: 1, retrying: true }));
});

it('does not allocate or read a workspace when both permission attempts fail', async () => {
  permissionRead.mockResolvedValue({ data: null, error: { code: '57014' }, status: 500 });
  await expect(tool().execute({ files: [{ path: 'report.md' }] })).rejects.toMatchObject({ status: 503, executed: false });
  expect(permissionRead).toHaveBeenCalledTimes(2);
  expect(resolveAssistantWorkspaceSource).not.toHaveBeenCalled();
  expect(openAssistantWorkspace).not.toHaveBeenCalled();
  expect(readFile).not.toHaveBeenCalled();
});

it('rechecks permission inside the filesystem tool after the outer guard passed', async () => {
  permissionRead.mockResolvedValueOnce({ data: true, error: null }).mockResolvedValue({ data: false, error: null });
  expect(await tool().execute({ files: [{ path: 'report.md' }] })).toMatchObject({ success: false, status: 403,
    executed: false, error: { effectStarted: false } });
  expect(permissionRead).toHaveBeenCalledTimes(2);
  expect(openAssistantWorkspace).not.toHaveBeenCalled();
  expect(readFile).not.toHaveBeenCalled();
});