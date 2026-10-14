import { randomBytes, randomUUID } from 'node:crypto';
import { createRequirementProvisioningTools } from '../requirement-provisioning';
import { defaultTestOnlyScopesForRequirement } from '../../services/platform-api/scopes-catalog';
import type { HostProfile } from '../profile';
import type { HostConfiguration, ToolContext, Workspace } from '../types';
import type { RequirementRun } from '../requirement-types';

// Any eager database/SDK initialization is a regression; every test is offline.
jest.mock('../../database/supabase-client', () => { throw new Error('Unexpected database initialization'); });
jest.mock('../../services/api-keys/ApiKeyService', () => { throw new Error('Unexpected key service initialization'); });

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function fixture() {
  const run: RequirementRun = { requirementId: randomUUID(), siteId: randomUUID(), userId: randomUUID(),
    instanceId: randomUUID(), runId: randomUUID(), executionGeneration: 1, sessionId: randomUUID() };
  const profile: HostProfile = { siteId: run.siteId, userId: run.userId, requirementId: run.requirementId,
    repositoryUrl: 'https://github.com/example/fixture.git', allowed: [], environment: {},
    deployment: { projectId: 'project-fixture', teamId: 'team-fixture', token: randomBytes(24).toString('hex') } };
  const configuration: HostConfiguration = { layers: { profile: { values: {} } }, redactionValues: [] };
  const host = { configuration,
    values: () => Object.assign({}, ...Object.values(configuration.layers).map(layer => layer.values)),
    setLayer: jest.fn(async (name: string, layer: HostConfiguration['layers'][string]) => {
      configuration.layers[name] = layer;
      configuration.redactionValues.push(...Object.values(layer.values));
    }), remember: jest.fn(async () => {}),
  };
  const key = randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 86400_000).toISOString();
  const mintKey = jest.fn(async () => ({ apiKey: key, expires_at: expiresAt }));
  const replaceEnvironment = jest.fn(async () => {});
  const request = jest.fn(async (_url: URL | RequestInfo, _init?: RequestInit): Promise<Response> => response({}));
  const assertActive = jest.fn(async () => {});
  const controller = new AbortController();
  const context: ToolContext = { sessionId: run.sessionId, operationId: randomUUID(), signal: controller.signal,
    assertActive: jest.fn(async () => {}) };
  const workspace = {} as Workspace;
  const options = { run, profile, host, workspace, branch: 'feature/requirement/full-branch', assertActive,
    dependencies: { request: request as typeof fetch, mintKey, replaceEnvironment } };
  const tool = (name: string) => createRequirementProvisioningTools(options).find(item => item.name === name)!;
  const execute = (name: string) => tool(name).execute({}, context);
  return { ...options, configuration, key, expiresAt, mintKey, replaceEnvironment, request, controller, context, options, tool, execute };
}

it('constructs independently optional tools without eager DB imports or allowed[] gates', () => {
  const f = fixture();
  expect(createRequirementProvisioningTools(f.options).map(tool => tool.name)).toEqual([
    'platform_key_provision', 'deployment_environment_sync', 'deployment_create',
  ]);
  delete f.profile.deployment;
  expect(createRequirementProvisioningTools(f.options).map(tool => tool.name)).toEqual(['platform_key_provision']);
  expect(f.mintKey).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
});

it.each(['platform_key_provision', 'deployment_environment_sync', 'deployment_create'])('%s rejects all model-supplied identities and values', async name => {
  const f = fixture();
  const result = await f.tool(name).execute({ projectId: 'other', token: f.key, branch: 'main', rotate: true }, f.context);
  expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENTS', effectStarted: false } });
  expect(JSON.stringify(result)).not.toContain(f.key);
  expect(f.mintKey).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
});

it('mints only default test scopes, saves the host layer before workspace injection and reuses it', async () => {
  const f = fixture();
  f.replaceEnvironment.mockImplementation(async () => {
    expect(f.host.setLayer).toHaveBeenCalledTimes(1);
    expect(f.host.values().API_KEY).toBe(f.key);
  });
  const first = await f.execute('platform_key_provision');
  expect(first).toMatchObject({ ok: true, output: { reused: false, expiresAt: f.expiresAt } });
  expect(f.mintKey).toHaveBeenCalledWith(f.run.userId, {
    name: `platform-${f.run.requirementId.slice(0, 8)}`, scopes: defaultTestOnlyScopesForRequirement(),
    site_id: f.run.siteId, expirationDays: 60, prefix: 'upk',
    metadata: { requirement_id: f.run.requirementId, posture: 'test-only', issued_by: 'harness.requirement-provisioning' },
  }, expect.any(AbortSignal));
  expect(f.host.setLayer).toHaveBeenCalledWith('platform', {
    values: { API_KEY: f.key, NEXT_API_URL: 'https://api.uncodie.com' }, expiresAt: f.expiresAt,
  });
  expect(f.replaceEnvironment).toHaveBeenCalledWith(f.workspace, f.host.values(), expect.arrayContaining([f.key]));
  expect(await f.execute('platform_key_provision')).toMatchObject({ ok: true, output: { reused: true } });
  expect(f.mintKey).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(first)).not.toContain(f.key);
  expect(f.assertActive.mock.calls.length).toBeGreaterThanOrEqual(8);
});

it('does not inject or retry a minted key when encrypted host persistence fails', async () => {
  const f = fixture(); f.host.setLayer.mockRejectedValue(new Error(f.key));
  const result = await f.execute('platform_key_provision');
  expect(result).toMatchObject({ ok: false, error: { ambiguous: true } });
  expect(f.replaceEnvironment).not.toHaveBeenCalled(); expect(f.mintKey).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toContain(f.key);
});

it('can provision without a workspace and replaces expired keys without legacy metadata mutations', async () => {
  const f = fixture();
  f.configuration.layers.platform = { values: { API_KEY: randomBytes(24).toString('hex') }, expiresAt: new Date(0).toISOString() };
  const [tool] = createRequirementProvisioningTools({ ...f.options, workspace: undefined });
  expect(await tool.execute({}, f.context)).toMatchObject({ ok: true, output: { reused: false, workspaceConfigured: false } });
  expect(f.mintKey).toHaveBeenCalledTimes(1); expect(f.replaceEnvironment).not.toHaveBeenCalled();
});

it.each(['abort', 'scope', 'ownership'])('stops before effects for %s', async kind => {
  const f = fixture();
  if (kind === 'abort') f.controller.abort();
  if (kind === 'scope') f.profile.siteId = randomUUID();
  if (kind === 'ownership') f.assertActive.mockRejectedValue(new Error(f.key));
  const result = await f.execute('platform_key_provision');
  expect(result).toMatchObject({ ok: false, error: { effectStarted: false } });
  expect(f.mintKey).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain(f.key);
});

it('checks cancellation after minting, before saving or injecting', async () => {
  const f = fixture(); f.mintKey.mockImplementation(async () => {
    f.controller.abort(); return { apiKey: f.key, expires_at: f.expiresAt };
  });
  expect(await f.execute('platform_key_provision')).toMatchObject({ ok: false, error: { ambiguous: true } });
  expect(f.host.setLayer).not.toHaveBeenCalled(); expect(f.replaceEnvironment).not.toHaveBeenCalled();
});

it('lists all pages before encrypted preview upserts, bound to project/team/full branch', async () => {
  const f = fixture();
  const app = randomBytes(24).toString('hex');
  f.configuration.layers.application = { values: { APP_TOKEN: app } };
  f.configuration.layers.tenant = { values: { SUPABASE_JWT: f.key } };
  f.configuration.layers.control = { values: { INTERNAL_SECRET: randomBytes(24).toString('hex') } };
  f.request.mockResolvedValueOnce(response({ envs: [{ id: 'env-fixture', key: 'APP_TOKEN', gitBranch: f.branch, target: ['preview'] }], pagination: { next: 100 } }))
    .mockResolvedValueOnce(response({ envs: [], pagination: { next: null } }))
    .mockResolvedValue(response({}));
  const result = await f.execute('deployment_environment_sync');
  expect(result).toMatchObject({ ok: true, output: { synced: 2 } });
  expect(f.request).toHaveBeenCalledTimes(4);
  const calls = f.request.mock.calls;
  expect((calls[1][0] as URL).searchParams.get('until')).toBe('100');
  for (const [url, init] of calls) {
    expect((url as URL).searchParams.get('teamId')).toBe('team-fixture');
    expect((url as URL).pathname).toContain('/projects/project-fixture/env');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.redirect).toBe('error');
  }
  expect(calls[2][1]?.method).toBe('PATCH'); expect(calls[3][1]?.method).toBe('POST');
  for (const [, init] of calls.slice(2)) {
    expect(JSON.parse(init!.body as string)).toMatchObject({ type: 'encrypted', gitBranch: f.branch, target: ['preview'] });
  }
  for (const secret of [app, f.key, f.profile.deployment!.token, f.configuration.layers.control.values.INTERNAL_SECRET]) {
    expect(JSON.stringify(result)).not.toContain(secret);
  }
  expect(f.mintKey).not.toHaveBeenCalled(); expect(f.host.setLayer).not.toHaveBeenCalled();
});

it.each(['loop', 'limit', 'malformed', 'unmarked-full'])('fails closed on %s pagination without any writes', async kind => {
  const f = fixture(); f.configuration.layers.application = { values: { APP_TOKEN: f.key } };
  let page = 0;
  f.request.mockImplementation(async () => {
    page++;
    if (kind === 'malformed') return response({ envs: [] , pagination: {} });
    if (kind === 'unmarked-full') return response({ envs: Array.from({ length: 100 }, (_, index) => ({ id: String(index), key: 'OTHER', target: ['preview'] })) });
    return response({ envs: [], pagination: { next: kind === 'loop' ? 100 : 100 + page } });
  });
  expect(await f.execute('deployment_environment_sync')).toMatchObject({ ok: false, error: { code: 'ENVIRONMENT_LIST_INCOMPLETE', effectStarted: false } });
  expect(f.request.mock.calls.length).toBeLessThanOrEqual(10);
  expect(f.request.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});

it.each(['SUPABASE_SERVICE_ROLE_KEY', 'VERCEL_TOKEN', 'GITHUB_TOKEN', 'OPENROUTER_API_KEY', 'NODE_OPTIONS'])('refuses control-plane %s before provider requests', async name => {
  const f = fixture(); f.configuration.layers.application = { values: { [name]: f.key } };
  const result = await f.execute('deployment_environment_sync');
  expect(result).toMatchObject({ ok: false, error: { code: 'UNSAFE_RUNTIME_ENVIRONMENT' } });
  expect(f.request).not.toHaveBeenCalled(); expect(JSON.stringify(result)).not.toContain(f.key);
});

it('never changes production or mixed-target branch variables', async () => {
  const f = fixture(); f.configuration.layers.application = { values: { APP_TOKEN: f.key } };
  f.request.mockResolvedValue(response({ envs: [{ id: 'env-fixture', key: 'APP_TOKEN', gitBranch: f.branch, target: ['production', 'preview'] }] }));
  expect(await f.execute('deployment_environment_sync')).toMatchObject({ ok: false, error: { code: 'ENVIRONMENT_TARGET_CONFLICT' } });
  expect(f.request).toHaveBeenCalledTimes(1);
});

it('stops on partial sync failure without retrying or silently succeeding', async () => {
  const f = fixture(); f.configuration.layers.application = { values: { APP_TOKEN: f.key, APP_SETTING: 'setting' } };
  f.request.mockResolvedValueOnce(response({ envs: [] })).mockResolvedValueOnce(response({ error: f.key }, 503));
  const result = await f.execute('deployment_environment_sync');
  expect(result).toMatchObject({ ok: false, error: { ambiguous: true } });
  expect(f.request).toHaveBeenCalledTimes(2); expect(JSON.stringify(result)).not.toContain(f.key);
});

const project = () => ({ id: 'project-fixture', name: 'fixture-project', link: { type: 'github', org: 'example', repo: 'fixture', repoId: 123 } });
it('creates preview from verified project GitHub link and full bound branch, independent of env/key tools', async () => {
  const f = fixture();
  f.request.mockResolvedValueOnce(response(project())).mockResolvedValueOnce(response({ id: 'deployment-fixture', env: { API_KEY: f.key } }));
  const result = await f.execute('deployment_create');
  expect(result).toMatchObject({ ok: true, output: { submitted: true, target: 'preview' } });
  expect(f.request).toHaveBeenCalledTimes(2);
  const [url, init] = f.request.mock.calls[1];
  expect((url as URL).pathname).toBe('/v13/deployments');
  expect(JSON.parse(init!.body as string)).toEqual({ name: 'fixture-project', project: 'project-fixture',
    gitSource: { type: 'github', repoId: '123', ref: f.branch } });
  expect(init!.signal).toBeInstanceOf(AbortSignal);
  expect(JSON.stringify(result)).not.toContain(f.key); expect(JSON.stringify(result)).not.toContain(f.profile.deployment!.token);
  expect(f.mintKey).not.toHaveBeenCalled(); expect(f.host.setLayer).not.toHaveBeenCalled();
});

it('does not deploy mismatched repositories or use an unverified hook as fallback', async () => {
  const f = fixture(); f.profile.deployment!.deployHookUrl = 'https://example.invalid/deploy';
  f.request.mockResolvedValue(response({ ...project(), link: { ...project().link, repo: 'other' } }));
  expect(await f.execute('deployment_create')).toMatchObject({ ok: false, error: { code: 'DEPLOYMENT_SOURCE_UNAVAILABLE', effectStarted: false } });
  expect(f.request).toHaveBeenCalledTimes(1);
});

it.each(['lost', 'server', 'receipt', 'cancelled'])('marks %s deployment outcomes ambiguous without replay or secret leakage', async kind => {
  const f = fixture(); f.request.mockResolvedValueOnce(response(project()));
  if (kind === 'lost') f.request.mockRejectedValueOnce(new Error(f.key));
  if (kind === 'server') f.request.mockResolvedValueOnce(response({ error: f.key }, 503));
  if (kind === 'receipt') f.request.mockResolvedValueOnce(response({ token: f.key }));
  if (kind === 'cancelled') f.request.mockImplementationOnce(async () => { f.controller.abort(); return response({ id: 'deployment-fixture' }); });
  const result = await f.execute('deployment_create');
  expect(result).toMatchObject({ ok: false, error: { ambiguous: true } });
  expect(f.request).toHaveBeenCalledTimes(2); expect(JSON.stringify(result)).not.toContain(f.key);
});