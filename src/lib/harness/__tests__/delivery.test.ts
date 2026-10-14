import { randomBytes, randomUUID } from 'node:crypto';
import { createDeliveryTools } from '../delivery-tools';
import type { HostProfile } from '../profile';
import type { Workspace, ToolContext } from '../types';

const scope = { siteId: randomUUID(), userId: randomUUID() };
const context: ToolContext = { sessionId: randomUUID(), operationId: 'op', signal: AbortSignal.timeout(10000), assertActive: jest.fn().mockResolvedValue(undefined) };
const workspace = { ref: { provider: 'vercel', id: 'test', root: '/vercel/sandbox' }, readFile: jest.fn(), writeFile: jest.fn() } as unknown as Workspace;
const profile = (allowed: string[]): HostProfile => ({ ...scope, repositoryUrl: 'https://repo.example.invalid/project.git',
  allowed, environment: {}, deployment: { token: randomBytes(24).toString('hex'), projectId: 'project',
    deployHookUrl: `https://api.vercel.com/v1/integrations/deploy/${randomBytes(24).toString('hex')}` } });

it('does not provision or expose delivery without explicit host grants', () => {
  expect(createDeliveryTools({ workspace, scope })).toEqual([]);
  expect(createDeliveryTools({ workspace, scope, profile: profile([]) })).toEqual([]);
});
it('installs tracking only into the agent-selected file, without build/deploy/state gates', async () => {
  (workspace.readFile as jest.Mock).mockResolvedValue('export default function Layout(){ return <html><body>Hello</body></html>; }');
  const [tool] = createDeliveryTools({ workspace, scope, profile: profile(['tracking_install']) });
  expect((await tool.execute({ path: 'web/layout.tsx' }, context)).ok).toBe(true);
  expect(workspace.writeFile).toHaveBeenCalledWith('web/layout.tsx', expect.stringContaining(scope.siteId), context.signal);
});
it('submits a configured deploy once and never exposes hook credentials', async () => {
  const p = profile(['deployment_trigger']); const request = jest.fn().mockResolvedValue(Response.json({ job: { id: 'job' } }));
  const [tool] = createDeliveryTools({ workspace, scope, profile: p, request });
  const result = await tool.execute({}, context);
  expect(result).toMatchObject({ ok: true, output: { submitted: true, jobId: 'job' } });
  expect(request).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toContain(p.deployment!.token);
  expect(JSON.stringify(result)).not.toContain(p.deployment!.deployHookUrl);
});
it('unknown deployment outcomes are data, not repeated effects', async () => {
  const p = profile(['deployment_trigger']); const request = jest.fn().mockRejectedValue(new Error(`request ${p.deployment!.deployHookUrl} failed`));
  const [tool] = createDeliveryTools({ workspace, scope, profile: p, request });
  const result = await tool.execute({}, context);
  expect(result).toMatchObject({ ok: false, error: { ambiguous: true } });
  expect(request).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toContain(p.deployment!.deployHookUrl);
});
it('status lookup cannot accept another project or return provider secret payloads', async () => {
  const p = profile(['deployment_status']);
  const request = jest.fn().mockResolvedValue(Response.json({ deployments: [{ uid: 'd', state: 'ERROR', url: 'example.vercel.app', secret: p.deployment!.token }] }));
  const [tool] = createDeliveryTools({ workspace, scope, profile: p, request });
  expect((await tool.execute({ projectId: 'another' }, context)).ok).toBe(false);
  expect(request).not.toHaveBeenCalled();
  const result = await tool.execute({}, context);
  expect(JSON.stringify(result)).not.toContain(p.deployment!.token);
  expect(result.output).toEqual([{ id: 'd', state: 'ERROR', url: 'https://example.vercel.app' }]);
});