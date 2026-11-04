import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createAssistantDeploymentTools } from '../deployment-tools';

const scope = { siteId: randomUUID(), userId: randomUUID() };
const instanceId = randomUUID();
const active = jest.fn(async () => {});
const token = randomBytes(24).toString('hex');

it('injects existing deploy tools without workspace/provider I/O', () => {
  const request = jest.fn();
  expect(createAssistantDeploymentTools(scope, instanceId, active, { env: {}, request }).map(tool => tool.name))
    .toEqual(['deployment_trigger', 'deployment_status']);
  expect(request).not.toHaveBeenCalled();
});

it('preserves existing configuration errors', async () => {
  const tools = createAssistantDeploymentTools(scope, instanceId, active, { env: {} });
  expect(await tools[0].execute({ thought_process: 'Deploy' })).toMatchObject({ ok: false,
    error: { code: 'DEPLOYMENT_NOT_CONFIGURED' } });
});

it('uses the existing status implementation with host credentials', async () => {
  const request = jest.fn().mockResolvedValue(Response.json({ deployments: [{ uid: 'dpl_test', state: 'READY', url: 'actual.vercel.app' }] }));
  const tools = createAssistantDeploymentTools(scope, instanceId, active,
    { env: { APPS_VERCEL_PROJECT_ID: 'project', VERCEL_TOKEN: token }, request });
  const result = await tools[1].execute({});
  expect(result).toMatchObject({ ok: true, output: [{ state: 'READY' }] });
  expect(JSON.stringify(result)).not.toContain(token);
  expect(request.mock.calls[0][0].searchParams.get('projectId')).toBe('project');
});

it('reuses a scoped profile hook and its existing grants', async () => {
  const hook = new URL('https://api.vercel.com');
  hook.pathname = `/v1/integrations/deploy/${randomBytes(24).toString('hex')}`;
  const request = jest.fn().mockResolvedValue(Response.json({ job: { id: 'job' } }));
  const env = { HARNESS_V2_PROFILES: JSON.stringify({ scoped: { ...scope,
    repositoryUrl: 'https://github.com/example/repo.git', allowed: ['deployment_trigger'], environment: {},
    deployment: { projectId: 'project', token, deployHookUrl: hook.href } } }) };
  const tools = createAssistantDeploymentTools(scope, instanceId, active, { env, request });
  expect(tools.map(tool => tool.name)).toEqual(['deployment_trigger']);
  const result = await tools[0].execute({});
  expect(result).toMatchObject({ ok: true, output: { submitted: true } });
  expect(JSON.stringify(result)).not.toContain(token);
  expect(JSON.stringify(result)).not.toContain(hook.href);
});

it('does not adopt another site profile or a requirement-owned profile', () => {
  const profile = { ...scope, repositoryUrl: 'https://github.com/example/repo.git',
    allowed: ['deployment_trigger'], environment: {}, deployment: { projectId: 'foreign', token } };
  const env = { HARNESS_V2_PROFILES: JSON.stringify({ foreign: { ...profile, siteId: randomUUID() },
    managed: { ...profile, requirementId: randomUUID() } }) };
  expect(createAssistantDeploymentTools(scope, instanceId, active, { env }).map(tool => tool.name))
    .toEqual(['deployment_trigger', 'deployment_status']);
});

it('includes the adapter in the standalone chat catalog without replacing requirement tools', () => {
  const core = readFileSync(path.join(__dirname, '../assistant-turn-core.ts'), 'utf8');
  expect(core).toContain('const deploymentTools = standaloneFiles && !fileContext.environment');
  expect(core).toContain('...workspaceTools, ...cloudTools, ...deploymentTools');
  expect(core).toContain('requirementHost ? [...context.customTools, ...requirementHost.tools]');
});