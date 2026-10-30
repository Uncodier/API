import { randomUUID } from 'node:crypto';
import { retryPendingCloudGit } from '../retry';
import { assertToolScreenAccess } from '@/app/api/agents/tools/router/screen-access';
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: {} }));
jest.mock('@/app/api/agents/tools/router/screen-access', () => ({ assertToolScreenAccess: jest.fn(async () => {}) }));

const env = { CLOUD_FILES_GITHUB_REPOSITORY: 'example/private-docs', CLOUD_FILES_GITHUB_TOKEN: randomUUID(), CLOUD_FILES_GITHUB_NO_DEPLOY: 'true' };
test('unconfigured evidence retry never claims work or starts execution', async () => {
  const rpc = jest.fn(); const publish = jest.fn();
  expect(await retryPendingCloudGit({ client: { rpc } as any, publish, env: {} })).toEqual({ attempted: 0, committed: 0 });
  expect(rpc).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
});
test('claims one durable revision and reauthorizes without running a model or workspace', async () => {
  const row = { site_id: randomUUID(), user_id: randomUUID(), instance_id: randomUUID(), requirement_id: randomUUID(), file_id: randomUUID(), version: 2 };
  const revision = { file_id: row.file_id, version: 2, git_status: 'pending' };
  const rpc = jest.fn(async (name: string) => ({ data: name === 'claim_cloud_git_publications' ? [row] : revision, error: null }));
  const publish = jest.fn(async (_scope: any, _revision: any, deps: any) => { await deps.assertActive(); return { ...revision, git_status: 'committed' } as any; });
  expect(await retryPendingCloudGit({ client: { rpc } as any, publish, env })).toEqual({ attempted: 1, committed: 1 });
  expect(rpc).toHaveBeenCalledWith('claim_cloud_git_publications', { p_limit: 1 });
  expect(publish).toHaveBeenCalledWith({ siteId: row.site_id, userId: row.user_id, instanceId: row.instance_id, requirementId: row.requirement_id }, revision, expect.any(Object));
  expect(assertToolScreenAccess).toHaveBeenCalled();
});
test('publication outage leaves durable retry state instead of claiming success', async () => {
  const row = { site_id: randomUUID(), user_id: randomUUID(), instance_id: randomUUID(), file_id: randomUUID(), version: 1 };
  const rpc = jest.fn(async (name: string) => ({ data: name === 'claim_cloud_git_publications' ? [row] : row, error: null }));
  const publish = jest.fn(async () => { throw new Error('synthetic provider outage'); });
  expect(await retryPendingCloudGit({ client: { rpc } as any, publish, env })).toEqual({ attempted: 1, committed: 0 });
  expect(rpc.mock.calls).toHaveLength(2);
});