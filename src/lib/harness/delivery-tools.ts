import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { BeforeEffectError, createRedactor, safeError } from './security';
import { transformHarnessTrackingScript } from '@/app/api/cron/shared/tracking-script-contract';
import type { HostProfile } from './profile';
import type { HarnessTool, Json, SessionScope, ToolResult, Workspace } from './types';

export const DELIVERY_CAPABILITIES = ['tracking_install', 'deployment_trigger', 'deployment_status'] as const;

/** Optional delivery. No requirement status writes, hidden builds, retries, or completion gates. */
export function createDeliveryTools(options: { workspace: Workspace; scope: SessionScope; profile?: HostProfile;
  request?: typeof fetch }): HarnessTool[] {
  const { workspace, scope, profile } = options;
  const request = options.request || fetch;
  const redact = createRedactor([profile?.deployment?.token || '', profile?.deployment?.deployHookUrl || '']);
  const tools: HarnessTool[] = [];
  const tool = <T extends z.ZodTypeAny>(name: string, description: string, effect: HarnessTool['effect'], schema: T,
    execute: (args: z.infer<T>, signal: AbortSignal) => Promise<ToolResult>) => {
    if (!profile?.allowed.includes(name)) return;
    tools.push({ name, description, effect,
      parameters: zodToJsonSchema(schema, { $refStrategy: 'none' }) as Record<string, unknown>,
      async execute(input, context) {
        const args = schema.safeParse(input);
        if (!args.success) return { ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'Use the declared tool schema.' } };
        await context.assertActive();
        try { return await execute(args.data, context.signal); }
        catch (error) { return { ok: false, error: { code: 'DELIVERY_FAILED', message: safeError(error, redact),
          ...(effect === 'write' && !(error instanceof BeforeEffectError) ? { ambiguous: true } : { effectStarted: false }) } }; }
      },
    });
  };
  tool('tracking_install', 'Explicitly add or repair Makinari tracking in the chosen JSX body layout. Does not enforce a repo layout or deploy. Unsupported files return an error without affecting other work.',
    'write', z.object({ path: z.string().min(1).max(4096) }).strict(), async ({ path }, signal) => {
      let result;
      try {
        const source = await workspace.readFile(path, signal);
        result = transformHarnessTrackingScript(source, scope.siteId);
      } catch { throw new BeforeEffectError('Tracking input unavailable or unsupported; no file was changed.'); }
      if (result.changed) await workspace.writeFile(path, result.source, signal);
      return { ok: true, output: { changed: result.changed, path, reason: result.reason } };
    });
  tool('deployment_trigger', 'Invoke the host-configured Vercel deploy hook once. It deploys the remote revision configured by the host, NOT unsaved workspace files. No automatic retry or build gate.',
    'write', z.object({}).strict(), async (_args, signal) => {
      const hook = profile?.deployment?.deployHookUrl;
      if (!hook) return { ok: false, error: { code: 'DEPLOYMENT_NOT_CONFIGURED', message: 'The host has not configured a deployment hook.' } };
      const url = new URL(hook);
      if (url.protocol !== 'https:' || url.hostname !== 'api.vercel.com' || !url.pathname.startsWith('/v1/integrations/deploy/') || url.username || url.password || url.port || url.hash || url.search) {
        return { ok: false, error: { code: 'INVALID_HOST_DEPLOYMENT', message: 'Invalid host deployment configuration.' } };
      }
      const response = await request(url, { method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
      if (!response.ok) {
        const rejectedBeforeEffect = [400, 401, 403, 404, 422, 429].includes(response.status);
        return { ok: false, error: { code: 'DEPLOYMENT_REJECTED', message: `Deploy hook returned HTTP ${response.status}`,
          ...(rejectedBeforeEffect ? { effectStarted: false } : { ambiguous: true }) } };
      }
      const body = await response.json();
      return { ok: true, output: { submitted: true, jobId: typeof body.job?.id === 'string' ? body.job.id : null,
        note: 'Submission is not deployment success. Inspect deployment_status.' } };
    });
  tool('deployment_status', 'Read deployments for the host-authorized Vercel project, optionally filtered by commit SHA. No deployment URL or project id is accepted from the model.',
    'read', z.object({ sha: z.string().regex(/^[a-f0-9]{40,64}$/i).optional() }).strict(), async ({ sha }, signal) => {
      const deployment = profile?.deployment;
      if (!deployment) return { ok: false, error: { code: 'DEPLOYMENT_NOT_CONFIGURED', message: 'No authorized deployment project.' } };
      const url = new URL('https://api.vercel.com/v6/deployments');
      url.searchParams.set('projectId', deployment.projectId); url.searchParams.set('limit', '5');
      if (deployment.teamId) url.searchParams.set('teamId', deployment.teamId);
      if (sha) url.searchParams.set('sha', sha);
      const response = await request(url, { headers: { Authorization: `Bearer ${deployment.token}` }, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
      if (!response.ok) return { ok: false, error: { code: 'DEPLOYMENT_STATUS_UNAVAILABLE', message: `Deployment provider returned HTTP ${response.status}` } };
      const body = await response.json();
      const deployments = (Array.isArray(body.deployments) ? body.deployments : []).slice(0, 5).map((item: Record<string, unknown>) => ({
        id: typeof item.uid === 'string' ? item.uid : null,
        state: typeof item.state === 'string' ? item.state : null,
        url: typeof item.url === 'string' && /^[A-Za-z0-9.-]+\.vercel\.app$/.test(item.url) ? `https://${item.url}` : null,
      }));
      return { ok: true, output: deployments as Json };
    });
  const tracking = tools.find(tool => tool.name === 'tracking_install');
  if (tracking) tracking.reconcile = async (args, context) => {
    await context.assertActive();
    const parsed = z.object({ path: z.string().min(1).max(4096) }).strict().safeParse(args);
    if (!parsed.success) return { state: 'unknown' };
    const source = await workspace.readFile(parsed.data.path, context.signal);
    const transformation = transformHarnessTrackingScript(source, scope.siteId);
    return transformation.changed ? { state: 'retry_safe', proof: 'tracking-transform:idempotent-current-source' }
      : { state: 'applied', proof: 'tracking-transform:verified-current-source', result: { ok: true, output: { path: parsed.data.path, changed: false } } };
  };
  return tools;
}