import { defaultTestOnlyScopesForRequirement } from '../services/platform-api/scopes-catalog';
import type { ApiKeyData } from '../services/api-keys/ApiKeyService';
import type { loadSessionConfiguration } from './host-configuration';
import type { HostProfile } from './profile';
import type { RequirementRun } from './requirement-types';
import type { HarnessTool, ToolContext, ToolResult, Workspace } from './types';

type Host = Awaited<ReturnType<typeof loadSessionConfiguration>>;
type KeyReceipt = { apiKey: string; expires_at: string };
export interface RequirementProvisioningDependencies {
  request?: typeof fetch;
  mintKey?: (userId: string, data: ApiKeyData, signal: AbortSignal) => Promise<KeyReceipt>;
  replaceEnvironment?: (workspace: Workspace, values: Record<string, string>, secrets: string[]) => Promise<void>;
  now?: () => number;
}

class ProvisioningError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
const fail = (code: string, message: string): never => { throw new ProvisioningError(code, message); };
const MAX_PAGES = 10;
const PAGE_SIZE = 100;
const noArguments = { type: 'object', properties: {}, additionalProperties: false };

/** Server-only adapters are lazy: importing tools never initializes a database or provider. */
async function mintKey(userId: string, data: ApiKeyData, signal: AbortSignal): Promise<KeyReceipt> {
  const [{ ApiKeyService }, { supabaseAdmin }] = await Promise.all([
    import('../services/api-keys/ApiKeyService'), import('../database/supabase-client'),
  ]);
  signal.throwIfAborted();
  // ApiKeyService owns encryption/generation; its insert is abortable without changing the legacy service.
  const client = { from: (table: string) => ({ insert: (row: Record<string, unknown>) => ({
    select: (columns: string) => ({ maybeSingle: async () => {
      const result = await supabaseAdmin.from(table).insert(row).select(columns).abortSignal(signal).maybeSingle();
      // Do not enter the legacy service's unabortable fallback read after a lost receipt.
      if (!result.data && !result.error) throw new Error('Key issuance receipt unavailable');
      return result;
    } }),
  }) }) };
  return ApiKeyService.createApiKey(userId, data, { client });
}

/** These optional tools never build, push, finalize requirements, or gate unrelated work. */
export function createRequirementProvisioningTools(options: {
  run: RequirementRun; profile?: HostProfile; branch: string; host: Host; workspace?: Workspace;
  assertActive(): Promise<void>; dependencies?: RequirementProvisioningDependencies;
}): HarnessTool[] {
  const { host, workspace, branch } = options;
  const run = { ...options.run };
  const profile = options.profile ? structuredClone(options.profile) : undefined;
  const deployment = profile?.deployment;
  const deps = options.dependencies || {};
  const request = deps.request || fetch;
  const now = deps.now || Date.now;
  const tools: HarnessTool[] = [];

  function tool(name: string, description: string,
    execute: (check: () => Promise<void>, effect: <T>(fn: () => Promise<T>) => Promise<T>, signal: AbortSignal) => Promise<ToolResult>) {
    tools.push({ name, description, parameters: noArguments, effect: 'write',
      async execute(args, context: ToolContext) {
        if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) {
          return { ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'This tool accepts no arguments.', effectStarted: false } };
        }
        let started = false;
        const signal = AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]);
        const check = async () => {
          signal.throwIfAborted();
          if (context.sessionId !== run.sessionId || !profile || profile.siteId !== run.siteId ||
            profile.userId !== run.userId || profile.requirementId !== run.requirementId) {
            fail('HOST_SCOPE_MISMATCH', 'This host configuration does not authorize the requirement run.');
          }
          await options.assertActive(); await context.assertActive(); signal.throwIfAborted();
        };
        const effect = async <T>(fn: () => Promise<T>): Promise<T> => {
          await check(); started = true;
          const result = await fn(); await check(); return result;
        };
        try { await check(); const result = await execute(check, effect, signal); await check(); return result; }
        catch (error) {
          // Never serialize provider/DB errors: they can contain submitted credentials.
          return { ok: false, error: { code: error instanceof ProvisioningError ? error.code : 'PROVISIONING_FAILED',
            message: error instanceof ProvisioningError ? error.message : 'Optional provisioning failed. Inspect host/provider state before any retry.',
            ...(started ? { ambiguous: true } : { effectStarted: false }) } };
        }
      },
    });
  }

  tool('platform_key_provision', 'Optionally ensure a 60-day test-only Platform API key in encrypted host state. Reuses an unexpired key; never rotates or exposes credentials. Does not provision a tenant or deploy.',
    async (_check, effect, signal) => {
      let layer = host.configuration.layers.platform;
      const reused = !!layer?.values.API_KEY && !!layer.expiresAt && Date.parse(layer.expiresAt) > now();
      if (!reused) {
        const base = host.values().NEXT_API_URL || 'https://api.uncodie.com';
        let url: URL;
        try { url = new URL(base); } catch { return fail('INVALID_API_URL', 'Host API URL is invalid.'); }
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
          fail('INVALID_API_URL', 'Host API URL must be an unauthenticated HTTPS URL.');
        }
        const created = await effect(() => (deps.mintKey || mintKey)(run.userId, {
          name: `platform-${run.requirementId.slice(0, 8)}`, scopes: defaultTestOnlyScopesForRequirement(),
          site_id: run.siteId, expirationDays: 60, prefix: 'upk',
          metadata: { requirement_id: run.requirementId, posture: 'test-only', issued_by: 'harness.requirement-provisioning' },
        }, signal));
        if (!created.apiKey || !Number.isFinite(Date.parse(created.expires_at)) || Date.parse(created.expires_at) <= now()) {
          fail('KEY_RECEIPT_INVALID', 'Key issuance did not return a usable receipt. Do not automatically issue another key.');
        }
        layer = { values: { API_KEY: created.apiKey, NEXT_API_URL: base.replace(/\/$/, '') }, expiresAt: created.expires_at };
        // Encrypted, lease-checked persistence MUST precede workspace injection.
        await effect(() => host.setLayer('platform', layer!));
      }
      if (workspace) await effect(async () => {
        const replace = deps.replaceEnvironment || (await import('./workspace')).replaceWorkspaceEnvironment;
        await replace(workspace, host.values(), host.configuration.redactionValues);
      });
      return { ok: true, output: { reused, expiresAt: layer!.expiresAt!, workspaceConfigured: !!workspace } };
    });

  if (!deployment) return tools;

  const providerUrl = (path: string) => {
    const url = new URL(path, 'https://api.vercel.com');
    if (deployment.teamId) url.searchParams.set('teamId', deployment.teamId);
    return url;
  };
  const headers = { Authorization: `Bearer ${deployment.token}`, 'Content-Type': 'application/json' };
  const validateBranch = () => {
    if (!branch || branch.length > 250 || /[\s\x00-\x1f~^:?*\[\\]/.test(branch) ||
      branch.includes('..') || branch.includes('@{') || branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/')) {
      fail('INVALID_HOST_BRANCH', 'Host branch is invalid.');
    }
  };
  const json = async (response: Response): Promise<any> => {
    if (!response.ok) fail('PROVIDER_REJECTED', `Deployment provider returned HTTP ${response.status}. No automatic retry.`);
    return response.json();
  };

  tool('deployment_environment_sync', 'Optionally upsert allowed runtime host values as encrypted, branch-specific preview variables. No model values or production targets. Does not provision credentials or deploy.',
    async (check, effect, signal) => {
      validateBranch();
      const values = host.values();
      // Only known runtime layers may be exported, never host control-plane metadata.
      const names = new Set(['profile', 'tenant', 'application', 'platform'].flatMap(name =>
        Object.keys(host.configuration.layers[name]?.values || {})));
      const entries = Object.entries(values).filter(([name]) => names.has(name));
      const control = /(?:SERVICE_ROLE|SERVICE_API_KEY|ENCRYPTION_KEY|CRON_SECRET|PRIVATE_KEY)|^(?:PATH|HOME|SHELL|ENV|BASH_ENV|NODE_OPTIONS|NODE_PATH)$|^(?:GIT_|GITHUB_|VERCEL_|AWS_|GOOGLE_|OPENROUTER_|LD_|DYLD_|PYTHON)/;
      if (entries.length > 64 || entries.some(([name, value]) => !/^[A-Z][A-Z0-9_]{0,100}$/.test(name) ||
        control.test(name) || typeof value !== 'string' || value.length > 8192 || /[\x00\r\n]/.test(value) ||
        /-----BEGIN .*PRIVATE KEY-----/.test(value) || [deployment.token, profile?.git?.password].filter(Boolean).includes(value))) {
        fail('UNSAFE_RUNTIME_ENVIRONMENT', 'Host runtime environment contains a disallowed value; nothing was exported.');
      }
      for (const name of ['tenant', 'platform']) {
        const layer = host.configuration.layers[name];
        if (layer?.expiresAt && !(Date.parse(layer.expiresAt) > now())) {
          fail('HOST_CREDENTIAL_EXPIRED', 'Refresh expired host credentials before exporting them.');
        }
      }
      if (!entries.length) return { ok: true, output: { synced: 0, target: 'preview' } };
      const existing: Array<{ id: string; key: string; gitBranch?: string; target: string[] }> = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (let page = 0; page < MAX_PAGES; page++) {
        await check();
        const url = providerUrl(`/v9/projects/${encodeURIComponent(deployment.projectId)}/env`);
        url.searchParams.set('gitBranch', branch); url.searchParams.set('limit', String(PAGE_SIZE));
        if (cursor) url.searchParams.set('until', cursor);
        const body = await json(await request(url, { headers, signal, redirect: 'error' }));
        await check();
        if (!Array.isArray(body.envs) || body.envs.length > PAGE_SIZE || body.envs.some((item: any) =>
          !item || typeof item.id !== 'string' || typeof item.key !== 'string' || !Array.isArray(item.target))) {
          fail('ENVIRONMENT_LIST_INCOMPLETE', 'Provider environment listing is invalid; no variables were written.');
        }
        existing.push(...body.envs);
        const next = body.pagination?.next;
        if (next === null || (!body.pagination && body.envs.length < PAGE_SIZE)) break;
        if (!['number', 'string'].includes(typeof next) || !/^\d+$/.test(String(next)) || seen.has(String(next)) || page === MAX_PAGES - 1) {
          fail('ENVIRONMENT_LIST_INCOMPLETE', 'Provider environment pagination was incomplete; no variables were written.');
        }
        cursor = String(next); seen.add(cursor);
      }
      // Validate every target before beginning a possibly partial multi-variable write.
      const writes = entries.map(([key, value]) => {
        const matches = existing.filter(item => item.key === key && item.gitBranch === branch);
        if (matches.length > 1 || matches.some(item => item.target.length !== 1 || item.target[0] !== 'preview')) {
          fail('ENVIRONMENT_TARGET_CONFLICT', 'Existing branch variables are not exclusively preview scoped; no variables were written.');
        }
        return { key, value, id: matches[0]?.id };
      });
      for (const { key, value, id } of writes) {
        const path = id ? `/v9/projects/${encodeURIComponent(deployment.projectId)}/env/${encodeURIComponent(id)}`
          : `/v10/projects/${encodeURIComponent(deployment.projectId)}/env`;
        await effect(async () => {
          const response = await request(providerUrl(path), { method: id ? 'PATCH' : 'POST', headers, signal, redirect: 'error',
            body: JSON.stringify({ key, value, type: 'encrypted', gitBranch: branch, target: ['preview'] }) });
          if (!response.ok) fail('ENVIRONMENT_SYNC_UNCONFIRMED', `Environment sync returned HTTP ${response.status}. Some variables may have changed; inspect before retrying.`);
        });
      }
      return { ok: true, output: { synced: writes.length, target: 'preview' } };
    });

  tool('deployment_create', 'Optionally create one preview deployment from the host-bound GitHub branch already pushed remotely. No model project/repository input, automatic retry, build gate, or production promotion.',
    async (check, effect, signal) => {
      validateBranch();
      const repo = new URL(profile!.repositoryUrl);
      const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(repo.pathname);
      if (repo.protocol !== 'https:' || repo.hostname !== 'github.com' || repo.port || repo.username || repo.password || repo.search || repo.hash || !match) {
        fail('DEPLOYMENT_SOURCE_UNAVAILABLE', 'Preview creation requires a host-bound GitHub repository. Other tools remain available.');
      }
      await check();
      const project = await json(await request(providerUrl(`/v9/projects/${encodeURIComponent(deployment.projectId)}`), { headers, signal, redirect: 'error' }));
      await check();
      const link = project.link;
      if (project.id !== deployment.projectId || typeof project.name !== 'string' || !/^[a-z0-9_-]{1,100}$/.test(project.name) ||
        link?.type !== 'github' || String(link.org).toLowerCase() !== match![1].toLowerCase() ||
        String(link.repo).toLowerCase() !== match![2].toLowerCase() || !/^\d+$/.test(String(link.repoId))) {
        fail('DEPLOYMENT_SOURCE_UNAVAILABLE', 'The host project must be linked to the bound GitHub repository. No deployment was created.');
      }
      await effect(async () => {
        // Omitting target is Vercel's preview default (never target: production).
        // A hook cannot prove its configured branch/target, so use the verified project link.
        const body = await json(await request(providerUrl('/v13/deployments'), { method: 'POST', headers, signal, redirect: 'error',
          body: JSON.stringify({ name: project.name, project: deployment.projectId,
            gitSource: { type: 'github', repoId: String(link.repoId), ref: branch } }) }));
        if (typeof body.id !== 'string' || !body.id) fail('DEPLOYMENT_UNCONFIRMED', 'Deployment returned no receipt. Inspect provider status before retrying.');
      });
      // No arbitrary provider payload (or provider-echoed secrets) enters the transcript.
      return { ok: true, output: { submitted: true, target: 'preview', note: 'Submission is not build success. Inspect deployment_status.' } };
    });
  return tools;
}