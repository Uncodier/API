import { guardRequirementAssistantTools, type RequirementAssistantHost } from '../requirement-host';

const workspace = ['read_files', 'list_files', 'search', 'apply_patch', 'exec', 'process_status', 'process_stop',
  'source_archive', 'deployment_create', 'deployment_environment_sync', 'deployment_status', 'tracking_install',
  'platform_key_provision', 'sandbox_exec', 'sandbox_get_or_create', 'sandbox_stop', 'activate_coding_agents', 'update_repo'];
const cloud = ['read_cloud_file', 'list_cloud_files', 'write_cloud_file'];

function fixture(environment: 'cloud' | 'workspace') {
  const host = { environment, assertActive: jest.fn(async () => {}), tools: [], refreshContext: async () => '',
    boundary: {} } as unknown as RequirementAssistantHost;
  const tools = [...workspace, ...cloud, 'requirement_progress'].map(name => ({ name, description: name,
    parameters: {}, execute: jest.fn(async () => ({ success: true })) }));
  return { host, tools };
}

test('cloud removes workspace, sandbox, repository and deploy tools before the router captures its catalog', () => {
  const { host, tools } = fixture('cloud');
  const guarded = guardRequirementAssistantTools(host, tools);
  // The router only receives these descriptors; filtering is not a prompt or an execute-time denial.
  const routerCatalog = new Map(guarded.map(tool => [tool.name, tool]));
  expect([...routerCatalog.keys()]).toEqual([...cloud, 'requirement_progress']);
  for (const name of workspace) expect(routerCatalog.has(name)).toBe(false);
  expect(host.assertActive).not.toHaveBeenCalled();
  for (const tool of tools) expect(tool.execute).not.toHaveBeenCalled();
});

test('workspace removes every cloud descriptor before routing', () => {
  const { host, tools } = fixture('workspace');
  const names = guardRequirementAssistantTools(host, tools).map(tool => tool.name);
  for (const name of cloud) expect(names).not.toContain(name);
  expect(names).toContain('read_files');
  expect(names).toContain('requirement_progress');
});

test('retained cloud tools check current authority immediately before execution', async () => {
  const { host, tools } = fixture('cloud');
  const guarded = guardRequirementAssistantTools(host, tools).find(tool => tool.name === 'write_cloud_file')!;
  const original = tools.find(tool => tool.name === guarded.name)!;
  jest.mocked(host.assertActive).mockRejectedValueOnce(new Error('Offline revoked owner'));
  await expect(guarded.execute({ content: 'Draft' })).rejects.toThrow('revoked owner');
  expect(original.execute).not.toHaveBeenCalled();
  await expect(guarded.execute({ content: 'Draft' })).resolves.toEqual({ success: true });
  expect(original.execute).toHaveBeenCalledWith({ content: 'Draft' });
});