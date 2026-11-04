import { createHash, randomUUID } from 'node:crypto';
import { deliverFileTool } from '@/app/api/robots/instance/assistant/deliver-file-tool';
import { resolveAssistantFileEnvironment } from '@/app/api/robots/instance/assistant/cloud-context';
import { filterRequirementEnvironmentTools } from '@/app/api/robots/instance/assistant/requirement-host';
import { routeTools } from '@/app/api/agents/tools/router/assistantProtocol';
import { assertToolScreenAccess, ToolScreenAccessDenied } from '@/app/api/agents/tools/router/screen-access';
import { createCloudFileStore } from '../store';
import { publishCloudRevision } from '../git';
import type { CloudRevision } from '../types';

jest.mock('@/app/api/robots/instance/assistant/cloud-context', () => ({ resolveAssistantFileEnvironment: jest.fn() }));
jest.mock('../store', () => ({
  ...jest.requireActual('../store'), createCloudFileStore: jest.fn(),
}));
jest.mock('../git', () => ({ ...jest.requireActual('../git'), publishCloudRevision: jest.fn() }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: {} }));
jest.mock('@/lib/services/embeddings-service', () => ({}));
jest.mock('@/app/api/agents/tools/router/screen-access', () => ({
  ...jest.requireActual('@/app/api/agents/tools/router/screen-access'),
  assertToolScreenAccess: jest.fn(),
  loadToolScreenAccess: jest.fn(async () => ({ isAdmin: true, blockedScreens: [] })),
}));

const scope = { siteId: randomUUID(), userId: randomUUID(), instanceId: randomUUID() };
const requirementId = randomUUID();
let revision: CloudRevision;
let store: ReturnType<typeof createCloudFileStore>;
beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(assertToolScreenAccess).mockResolvedValue(undefined);
  jest.mocked(resolveAssistantFileEnvironment).mockResolvedValue({ environment: 'workspace', requirementId });
  const content = '<!doctype html><title>Quarterly results</title><h1>Quarterly results</h1>';
  revision = { file_id: randomUUID(), version: 1, instance_id: scope.instanceId, requirement_id: requirementId,
    name: 'results.html', mime: 'text/html', content, bytes: Buffer.byteLength(content),
    sha256: createHash('sha256').update(content).digest('hex'), git_status: 'pending' };
  store = { write: jest.fn(async () => ({ ...revision, state: 'created' })),
    read: jest.fn(async () => revision), list: jest.fn(async () => ({ files: [revision], next_offset: null })),
  } as unknown as ReturnType<typeof createCloudFileStore>;
  jest.mocked(createCloudFileStore).mockReturnValue(store);
  jest.mocked(publishCloudRevision).mockImplementation(async (_scope, saved) => ({ ...saved,
    git_status: 'committed', git_commit_sha: 'a'.repeat(40) }));
});
const tool = () => deliverFileTool(scope.siteId, scope.userId, scope.instanceId);
const create = () => ({ action: 'create', name: revision.name, mime: revision.mime, content: revision.content });

it('allows read pagination across the full document size in the routed schema', () => {
  expect(tool().parameters.properties.offset).toMatchObject({ maximum: 262144 });
});

it.each(['cloud', 'workspace', undefined] as const)('exposes delivery on demand without weakening the %s file boundary', environment => {
  const tools = filterRequirementEnvironmentTools(environment, [tool()]);
  expect(tools.map(tool => tool.name)).toEqual(['deliver_file']);
  expect(routeTools(tools, scope).map(tool => tool.name)).toEqual(['tools']);
  expect(resolveAssistantFileEnvironment).not.toHaveBeenCalled();
  expect(createCloudFileStore).not.toHaveBeenCalled();
});

it('saves a workspace agent document and pushes with the persisted requirement binding', async () => {
  const result = await tool().execute(create());
  expect(result).toMatchObject({ ok: true, output: { saved: true, git_status: 'committed',
    git_commit_sha: 'a'.repeat(40), file_id: revision.file_id, version: 1, download_url: expect.any(String) } });
  expect(store.write).toHaveBeenCalledWith({ ...scope, requirementId }, expect.objectContaining(create()));
  expect(publishCloudRevision).toHaveBeenCalledTimes(1);
  expect(assertToolScreenAccess).toHaveBeenCalledWith('write_cloud_file', { ...scope, requirementId });
});

it('also supports standalone agents with no requirement', async () => {
  jest.mocked(resolveAssistantFileEnvironment).mockResolvedValue({});
  revision.requirement_id = null;
  expect(await tool().execute(create())).toMatchObject({ ok: true, output: { saved: true } });
  expect(store.write).toHaveBeenCalledWith({ ...scope, requirementId: undefined }, expect.anything());
});

it.each(['list', 'read'])('supports %s without triggering a push', async action => {
  const args = action === 'read' ? { file_id: revision.file_id } : {};
  expect(await tool().execute({ action, ...args })).toMatchObject({ ok: true });
  expect(store.write).not.toHaveBeenCalled();
  expect(publishCloudRevision).not.toHaveBeenCalled();
});

it('preserves the saved receipt when Git is unavailable', async () => {
  jest.mocked(publishCloudRevision).mockRejectedValue(new Error('Offline Git unavailable'));
  expect(await tool().execute(create())).toMatchObject({ ok: true, output: { saved: true, git_status: 'pending' } });
});

it.each([
  { requirement_id: randomUUID() }, { site_id: randomUUID() }, { user_id: randomUUID() },
  { name: '../app/page.tsx' }, { mime: 'application/pdf' }, { content: 'a'.repeat(262145) },
])('rejects unsafe or unsupported delivery input %j', async override => {
  expect(await tool().execute({ ...create(), ...override })).toMatchObject({ ok: false });
  expect(store.write).not.toHaveBeenCalled();
  expect(publishCloudRevision).not.toHaveBeenCalled();
});

it('does not grant writes when the actor lacks assets access', async () => {
  jest.mocked(assertToolScreenAccess).mockRejectedValue(new ToolScreenAccessDenied());
  expect(await tool().execute(create())).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  expect(store.write).not.toHaveBeenCalled();
});

it('does not resolve or write without a host user identity', async () => {
  expect(await deliverFileTool(scope.siteId, undefined, scope.instanceId).execute(create()))
    .toMatchObject({ ok: false, error: { code: 'forbidden' } });
  expect(resolveAssistantFileEnvironment).not.toHaveBeenCalled();
});

it('stops before writing when the requirement binding changes', async () => {
  jest.mocked(resolveAssistantFileEnvironment).mockResolvedValueOnce({ environment: 'workspace', requirementId })
    .mockResolvedValue({ environment: 'workspace', requirementId: randomUUID() });
  expect(await tool().execute(create())).toMatchObject({ ok: false, error: { code: 'inactive' } });
  expect(store.write).not.toHaveBeenCalled();
});

it('keeps canonical version-fenced edits and conflict receipts', async () => {
  jest.mocked(store.write).mockResolvedValue({ ...revision, state: 'conflict' });
  expect(await tool().execute({ action: 'replace', file_id: revision.file_id, expected_version: 1, content: 'New version' }))
    .toMatchObject({ ok: false, error: { code: 'conflict' } });
  expect(publishCloudRevision).not.toHaveBeenCalled();
});