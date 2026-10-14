/** Optional host integrations. The engine never imports this module or requires a legacy requirement.
 * No plan/backlog/runner mutations, automatic gates, deployment, or arbitrary internal-tool router.
 */
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Sandbox } from '@vercel/sandbox';
import type { EnsureTenantResult } from '@/lib/services/apps-platform/tenant-provisioner';
import type { TenantCapabilities } from '@/lib/services/apps-platform/tenant-capabilities';
import type { TenantStorageBinding } from '@/lib/services/apps-platform/tenant-storage';
import type { MigrationExecutionContext } from '@/lib/services/apps-platform/migration-execution';
import type { MigrationBatchResult } from '@/lib/services/apps-platform/migration-applier';
import { createRedactor } from './security';
import type { HarnessTool, Json, SessionScope, ToolContext, Workspace } from './types';

export interface CapabilityOptions {
  scope: SessionScope;
  requirementId?: string;
  workspace: Workspace;
  assertActive: () => Promise<void>;
  configureEnvironment: (values: Record<string, string>) => Promise<void>;
  saveEnvironment?: (layer: string, values: Record<string, string>, metadata: { expiresAt: string;
    refresh: { kind: 'tenant'; requirementId: string } }) => Promise<void>;
  allowed: string[];
  cronRun?: { requirementId: string; instanceId: string; runId: string; executionGeneration: number; sessionId: string };
}

interface RequirementBinding {
  id: string; site_id: string; user_id: string; status: string;
  cron_lock_active: boolean; cron_lock_expires_at: string | null;
  metadata: { runner_instance_id?: string; requirement_execution_generation?: number } | null;
}
interface RunnerBinding { id: string; site_id: string; user_id: string; status: string; is_archived: boolean }
interface LegacyTool { name: string; execute(args: never): Promise<unknown> }
interface IntegrationContext { options: CapabilityOptions; assertCurrent: () => Promise<void>; signal: AbortSignal }

/** Host injection seam for offline tests. Defaults below call existing production helpers lazily. */
export interface CapabilityDependencies {
  loadRequirement(id: string): Promise<RequirementBinding | null>;
  loadRunner(id: string): Promise<RunnerBinding | null>;
  ensureTenant(input: { requirement_id: string; site_id: string; user_id: string }): Promise<EnsureTenantResult>;
  issueTenantJWT(input: { tenant_id: string; schema: string; user_id: string; expiresInSec: number }): Promise<{ token: string; expires_at: string }>;
  publicConfig(): Promise<{ url: string; anonKey: string }>;
  tenantCapabilities(id: string): Promise<TenantCapabilities>;
  storageBinding(id: string, scope: SessionScope): Promise<TenantStorageBinding>;
  ensureStorage(binding: TenantStorageBinding): Promise<{ bucket: string; created: boolean }>;
  verifyStorage(binding: TenantStorageBinding): Promise<void>;
  inspect(id: string, table: string): Promise<unknown>;
  migrate(context: IntegrationContext, execution: MigrationExecutionContext): Promise<MigrationBatchResult>;
  legacy(name: string, args: Record<string, unknown>, context: IntegrationContext): Promise<unknown>;
  installBrowser(context: IntegrationContext): Promise<void>;
}

class CapabilityError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
const unavailable = (code: string, message: string): never => { throw new CapabilityError(code, message); };

/** SDK stays at the integration boundary. Never reconnect a model-selected VM or resume a stopped VM. */
async function rawSandbox(context: IntegrationContext): Promise<Sandbox> {
  await context.assertCurrent();
  const ref = context.options.workspace.ref;
  if (ref.provider !== 'vercel' || ref.root !== '/vercel/sandbox') {
    return unavailable('WORKSPACE_UNSUPPORTED', 'Legacy integration requires the canonical Vercel workspace.');
  }
  const { Sandbox: SDK } = await import('@vercel/sandbox');
  const raw = await SDK.get({ name: ref.id, resume: false, signal: context.signal });
  // Helpers do not receive process.env or runtime credentials. Recheck before each SDK operation.
  return new Proxy(raw, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof value !== 'function') return value;
    if (key === 'runCommand') {
      return async (input: string | Record<string, unknown>, argv?: string[]) => {
        context.signal.throwIfAborted();
        await context.assertCurrent();
        const command = typeof input === 'string' ? { cmd: input, args: argv || [] } : input;
        if (command.sudo || typeof command.cmd !== 'string' ||
          (command.args !== undefined && (!Array.isArray(command.args) || command.args.some(arg => typeof arg !== 'string')))) {
          return unavailable('UNSAFE_LEGACY_COMMAND', 'Legacy integration requested unsupported command privileges.');
        }
        // Never inherit image/host secrets; retain SDK Command semantics required by legacy helpers.
        return target.runCommand({ cmd: '/usr/bin/env', args: ['-i', 'PATH=/usr/local/bin:/usr/bin:/bin',
          'HOME=/tmp', 'LANG=C.UTF-8', 'GIT_CONFIG_GLOBAL=/dev/null', 'GIT_CONFIG_SYSTEM=/dev/null',
          'GIT_TERMINAL_PROMPT=0', command.cmd, ...(command.args as string[] || [])],
          cwd: typeof command.cwd === 'string' ? command.cwd : ref.root,
          timeoutMs: Math.min(120000, typeof command.timeoutMs === 'number' ? command.timeoutMs : 60000),
          ...(command.detached === true ? { detached: true } : {}),
          signal: command.signal instanceof AbortSignal ? AbortSignal.any([context.signal, command.signal]) : context.signal });
      };
    }
    if (['writeFiles', 'readFile', 'readFileToBuffer', 'update'].includes(String(key))) {
      return async (...args: unknown[]) => {
        context.signal.throwIfAborted();
        await context.assertCurrent();
        return value.apply(target, args);
      };
    }
    return value.bind(target);
  } });
}

const defaults: CapabilityDependencies = {
  async loadRequirement(id) {
    const { supabaseAdmin } = await import('@/lib/database/supabase-client');
    const { data, error } = await supabaseAdmin.from('requirements')
      .select('id,site_id,user_id,status,cron_lock_active,cron_lock_expires_at,metadata').eq('id', id).maybeSingle();
    if (error) throw new Error('Requirement lookup unavailable');
    return data;
  },
  async loadRunner(id) {
    const { supabaseAdmin } = await import('@/lib/database/supabase-client');
    const { data, error } = await supabaseAdmin.from('remote_instances')
      .select('id,site_id,user_id,status,is_archived').eq('id', id).maybeSingle();
    if (error) throw new Error('Runner lookup unavailable');
    return data;
  },
  async ensureTenant(input) { return (await import('@/lib/services/apps-platform/tenant-provisioner')).ensureTenant(input); },
  async issueTenantJWT(input) { return (await import('@/lib/database/apps-supabase')).issueTenantJWT(input); },
  async publicConfig() { return (await import('@/lib/database/apps-supabase')).getAppsPublicConfig(); },
  async tenantCapabilities(id) { return (await import('@/lib/services/apps-platform/tenant-capabilities-service')).getTenantCapabilities(id); },
  async storageBinding(id, scope) {
    const { getAppsAdminClient } = await import('@/lib/database/apps-supabase');
    const { data, error } = await getAppsAdminClient().from('apps_tenants')
      .select('tenant_id,schema,bucket,status,site_id,user_id').eq('requirement_id', id).maybeSingle();
    if (error || !data || data.status !== 'active' || data.site_id !== scope.siteId || data.user_id !== scope.userId) {
      return unavailable('TENANT_UNAVAILABLE', 'An active tenant matching the host binding is required.');
    }
    return { requirementId: id, tenantId: data.tenant_id, schema: data.schema, bucket: data.bucket,
      siteId: scope.siteId, userId: scope.userId };
  },
  async ensureStorage(binding) { return (await import('@/lib/services/apps-platform/tenant-storage')).ensureTenantStorage(binding); },
  async verifyStorage(binding) { return (await import('@/lib/services/apps-platform/tenant-storage')).verifyTenantStorage(binding); },
  async inspect(id, table) {
    const { sandboxDbInspectTool } = await import('@/app/api/agents/tools/sandbox/sandbox-db-inspect');
    return sandboxDbInspectTool(id).execute({ table_name: table });
  },
  async migrate(context, execution) {
    const sandbox = await rawSandbox(context);
    const { applyPendingMigrations } = await import('@/lib/services/apps-platform/migration-applier');
    return applyPendingMigrations(sandbox, execution.requirementId, [], execution, { assertCurrent: execution.assertCurrent });
  },
  async legacy(name, args, context) {
    const sandbox = await rawSandbox(context);
    if (name === 'sandbox_preview_expose') {
      const { SANDBOX_VISUAL_PROBE_PORT } = await import('@/lib/services/sandbox-constants');
      await sandbox.update({ ports: [...new Set([...sandbox.routes.map(route => route.port), SANDBOX_VISUAL_PROBE_PORT])] }, { signal: context.signal });
      return { exposed: true, port: SANDBOX_VISUAL_PROBE_PORT, warning: 'Public preview remains exposed until host workspace configuration changes.' };
    }
    if (name === 'sandbox_browser') {
      const { sandboxBrowserTool } = await import('@/app/api/agents/tools/sandbox/sandbox-browser-tool');
      return sandboxBrowserTool(sandbox, { allowedDomains: ['localhost', '127.0.0.1'] }).execute(args);
    }
    if (name === 'sandbox_capture_screenshots' || name === 'sandbox_run_scenario') {
      const { SANDBOX_VISUAL_PROBE_PORT } = await import('@/lib/services/sandbox-constants');
      if (!sandbox.routes.some(route => route.port === SANDBOX_VISUAL_PROBE_PORT)) {
        return unavailable('PREVIEW_PORT_REQUIRED', 'Host must allow sandbox_preview_expose and invoke it explicitly before screenshot/scenario tools.');
      }
    }
    const { getQaSandboxTools } = await import('@/app/api/agents/tools/sandbox/qa-tools');
    // No backlog_item_id/plan_id/active_step_id: QA helpers cannot persist legacy gate evidence.
    const tools = getQaSandboxTools(sandbox, context.options.requirementId);
    const tool = (tools as LegacyTool[]).find(candidate => candidate.name === name);
    if (!tool) return unavailable('CAPABILITY_UNAVAILABLE', 'Integration adapter is unavailable.');
    return tool.execute(args as never);
  },
  async installBrowser(context) {
    const sandbox = await rawSandbox(context);
    await (await import('@/lib/services/workflow-robot/agent-browser-runtime')).installWorkflowAgentBrowser(sandbox);
  },
};

const none = z.object({}).strict();
const localPath = z.string().max(300).refine(value => value.startsWith('/') && !value.startsWith('//') && !/[\\\r\n]/.test(value), 'Use a local route path');
const duration = z.number().int().min(1000).max(60000).optional();
const routes = z.array(localPath).min(1).max(6).optional();
const schemas = {
  sandbox_db_provision: none,
  sandbox_db_capabilities: none,
  sandbox_db_inspect: z.object({ table_name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/) }).strict(),
  sandbox_db_migrate: none,
  sandbox_storage_ensure: none,
  sandbox_storage_verify: none,
  sandbox_probe_routes: z.object({ routes, duration_ms: duration }).strict(),
  sandbox_probe_api: z.object({ endpoints: z.array(z.object({ path: localPath,
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).optional(), payload: z.unknown().optional() }).strict()).min(1).max(10), duration_ms: duration }).strict(),
  // Fixed directory: no shell/path traversal through legacy scenario discovery.
  sandbox_run_scenario: z.object({ duration_ms: duration }).strict(),
  sandbox_tail_server_log: z.object({ max_bytes: z.number().int().min(512).max(24000).optional() }).strict(),
  sandbox_tail_api_log: z.object({ route: localPath, max_lines: z.number().int().min(10).max(500).optional() }).strict(),
  sandbox_capture_screenshots: z.object({ routes, protected_routes: routes,
    boot_timeout_ms: z.number().int().min(5000).max(60000).optional(),
    page_timeout_ms: z.number().int().min(1000).max(30000).optional() }).strict(),
  sandbox_visual_critique: z.object({ screenshots: z.array(z.object({ url: z.string().min(1).max(2000),
    route: localPath, viewport: z.string().max(80) }).strict()).min(1).max(6),
    step: z.object({ order: z.number().int().min(0), title: z.string().max(200).optional(),
      instructions: z.string().max(2000).optional(), expected_output: z.string().max(2000).optional() }).strict(),
    rubric: z.string().max(4000).optional(), brand_context: z.string().max(2000).optional() }).strict(),
  sandbox_browser_install: none,
  sandbox_preview_expose: none,
  sandbox_browser: z.object({ action: z.enum(['open', 'snapshot', 'click', 'fill', 'type', 'get_text', 'wait', 'press', 'close']),
    url: z.string().url().max(2000).refine(value => { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) &&
      ['localhost', '127.0.0.1'].includes(url.hostname) && !url.username && !url.password; }).optional(),
    ref: z.string().max(1000).optional(), value: z.string().max(4000).optional(), interactive: z.boolean().optional(),
    load: z.enum(['load', 'domcontentloaded', 'networkidle']).optional(), milliseconds: z.number().int().min(1).max(30000).optional(),
    key: z.string().max(100).optional() }).strict(),
};
type CapabilityName = keyof typeof schemas;
const descriptions: Record<CapabilityName, string> = {
  sandbox_db_provision: 'Idempotently provision tenant DB/auth/storage and configure 15-minute app credentials host-side. Returns names/metadata, never credentials. Runtime exec must explicitly opt in.',
  sandbox_db_capabilities: 'Read verified tenant DB/auth/storage capability metadata; no provisioning.',
  sandbox_db_inspect: 'Inspect tenant table accessibility. Returns only a receipt; no row values or credentials.',
  sandbox_db_migrate: 'Apply pending static tenant migrations with the existing constrained applier. Preserves migration holds; no plan mutations or automatic QA.',
  sandbox_storage_ensure: 'Ensure the bound tenant private bucket using verified registry/policy configuration. Does not provision a missing tenant.',
  sandbox_storage_verify: 'Read-only verification of the bound tenant private bucket and policies.',
  sandbox_probe_routes: 'On-demand Next runtime route probe; no gate or evidence persistence. Raw legacy process has no host runtime credentials.',
  sandbox_probe_api: 'On-demand local API probe (may mutate app data); no gate or evidence persistence. Raw process has no host runtime credentials.',
  sandbox_run_scenario: 'Run all .qa/scenarios with existing E2E helper on demand, without plan/gate receipts. Requires explicitly exposed preview port 3000. No automatic build.',
  sandbox_tail_server_log: 'Read the last legacy runtime probe server log.',
  sandbox_tail_api_log: 'Read local API-related lines from the last legacy probe log.',
  sandbox_capture_screenshots: 'On-demand local Next screenshots using private requirement-scoped evidence storage. Requires explicitly exposed preview port 3000. No plan or backlog writes.',
  sandbox_visual_critique: 'On-demand existing visual reviewer over requirement-scoped screenshot locators. Uses host vision provider; returns review as data, never advances a plan.',
  sandbox_browser_install: 'Explicitly install the existing agent-browser runtime in this workspace. Requires sandbox package/network availability.',
  sandbox_preview_expose: 'Explicitly expose public preview port 3000 for this workspace, preserving existing ports. Separate host permission required; no app process is started.',
  sandbox_browser: 'Control installed agent-browser for localhost only. No host credentials, arbitrary external URL, or value_env support.',
};
const requiresBinding = (name: string) => /^sandbox_(db_|storage_|capture_screenshots$|visual_critique$)/.test(name);
const readOnly = new Set(['sandbox_db_capabilities', 'sandbox_db_inspect', 'sandbox_storage_verify', 'sandbox_tail_server_log', 'sandbox_tail_api_log']);

/** Honest parity manifest: availability means dispatch exists, not that dependencies are installed. */
export const CAPABILITY_MANIFEST = {
  implemented: Object.keys(schemas).map(name => ({ name, requirement_binding: requiresBinding(name),
    description: descriptions[name as CapabilityName] })),
  reused: ['ensureTenant', 'issueTenantJWT', 'getTenantCapabilities', 'sandboxDbInspectTool',
    'ensureTenantStorage', 'verifyTenantStorage', 'applyPendingMigrations', 'getQaSandboxTools',
    'sandboxBrowserTool', 'installWorkflowAgentBrowser'],
  unsupported: [
    { name: 'full_binary_backup', reason: 'Separate source_archive supports safe bounded UTF-8 source files, not a full binary backup or legacy archive/lifecycle authority.' },
    { name: 'source_checkpoint', reason: 'Use generic git commands with host-scoped broker; legacy checkpoint gates excluded.' },
  ],
  separate_factory: ['tracking_install', 'deployment_trigger', 'deployment_status', 'source_archive'],
  restrictions: ['Host allowed names only; unknown names never dispatch.', 'Legacy binding requires a drained, paused, nonarchived runner and no cron lease on every call.',
    'No automatic build/lint/test/QA/deploy. Generic exec remains independent.',
    'QA/browser SDK helpers do not receive the host runtime environment; use explicit runtime exec for credentialed app processes.',
    'Screenshot/scenario tools require public preview port 3000. Only separately host-authorized sandbox_preview_expose can expose it; discovery/QA never expose ports implicitly.',
    'App credentials are RLS-constrained, expire after 15 minutes, and are readable by untrusted code sharing the VM. Not a secret vault.',
    'Operator must preserve the drained legacy binding for the session; this adapter does not claim, drain, resume, or hand off a legacy runner.'],
};

// Strip secret-bearing fields recursively before pattern/known-value redaction. Never return DB samples.
function safeJson(value: unknown, redact: (text: string) => string): Json {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return redact(value).slice(0, 24000);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.slice(0, 100).map(item => safeJson(item, redact));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) =>
    !/(?:jwt|token|secret|password|credential|authorization|service.?key|sample_data)/i.test(key))
    .map(([key, item]) => [redact(key), safeJson(item, redact)]));
  return null;
}

/** No dependency is called during construction. Missing optional services become tool-result data. */
export async function createCapabilityTools(options: CapabilityOptions,
  overrides: Partial<CapabilityDependencies> = {}): Promise<HarnessTool[]> {
  const deps = { ...defaults, ...overrides };
  // Copy the host contract: caller/model mutation cannot widen the allowlist or retarget identity.
  options = { ...options, scope: { ...options.scope }, allowed: [...options.allowed] };
  const allowed = new Set(options.allowed);
  const secrets = new Set<string>();
  const redact = (text: string) => createRedactor([...secrets])(text);
  let pinned: { runner: string; generation: number } | undefined;
  async function verify(context: ToolContext, required: boolean): Promise<RequirementBinding | undefined> {
    context.signal.throwIfAborted();
    await context.assertActive();
    await options.assertActive();
    if (!required) return;
    if (!options.requirementId) {
      if (required) return unavailable('REQUIREMENT_BINDING_REQUIRED', 'Host must explicitly bind an existing requirement for this capability.');
      return;
    }
    const req = await deps.loadRequirement(options.requirementId);
    if (!req || req.id !== options.requirementId || req.site_id !== options.scope.siteId || req.user_id !== options.scope.userId || req.status !== 'in-progress') {
      return unavailable('REQUIREMENT_BINDING_INVALID', 'Requirement ownership or runnable status does not match the host binding.');
    }
    const ownedCron = options.cronRun;
    if (ownedCron) {
      if (ownedCron.requirementId !== req.id || req.metadata?.runner_instance_id !== ownedCron.instanceId ||
        (req.metadata?.requirement_execution_generation ?? 0) !== ownedCron.executionGeneration) {
        return unavailable('REQUIREMENT_BINDING_INVALID', 'Cron capability does not match its host execution.');
      }
      const { supabaseAdmin } = await import('@/lib/database/supabase-client');
      const result = await supabaseAdmin.rpc('assert_agent_requirement_run', {
        p_requirement_id: req.id, p_run_id: ownedCron.runId, p_generation: ownedCron.executionGeneration,
        p_session_id: ownedCron.sessionId, p_allow_terminal: false, p_renew_seconds: 300,
      });
      if (result.error || result.data !== true) return unavailable('REQUIREMENT_BINDING_CHANGED', 'Cron execution changed.');
      return req;
    }
    if (req.cron_lock_active !== false || (req.cron_lock_expires_at !== null &&
      (!Number.isFinite(Date.parse(req.cron_lock_expires_at)) || Date.parse(req.cron_lock_expires_at) > Date.now()))) {
      return unavailable('LEGACY_RUNNER_BUSY', 'A legacy cron owner may still be active; operator drain is required.');
    }
    const runnerId = req.metadata?.runner_instance_id;
    const generation = req.metadata?.requirement_execution_generation ?? 0;
    const runner = runnerId ? await deps.loadRunner(runnerId) : null;
    if (!runner || runner.id !== runnerId || runner.site_id !== options.scope.siteId || runner.user_id !== options.scope.userId ||
      runner.status !== 'paused' || runner.is_archived !== false || !Number.isSafeInteger(generation) || generation < 0) {
      return unavailable('LEGACY_RUNNER_NOT_DRAINED', 'An explicitly paused, nonarchived matching legacy runner is required.');
    }
    if (pinned && (pinned.runner !== runnerId || pinned.generation !== generation)) {
      return unavailable('REQUIREMENT_BINDING_CHANGED', 'Legacy execution generation or runner changed during this session slice.');
    }
    pinned = { runner: runnerId!, generation };
    return req;
  }
  const tools: HarnessTool[] = [{ name: 'capability_manifest', effect: 'read',
    description: 'Discover fixed host-enabled optional integrations, binding requirements, and explicit parity gaps. Does not provision services.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(args, context) {
      if (!none.safeParse(args).success) return { ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'No discovery arguments are accepted.' } };
      try {
        context.signal.throwIfAborted();
        await context.assertActive();
        await options.assertActive();
        return { ok: true, output: safeJson({ ...CAPABILITY_MANIFEST,
          ...(options.cronRun ? { restrictions: CAPABILITY_MANIFEST.restrictions.filter(text =>
            !text.includes('drained') && !text.includes('Operator must')).concat('The existing requirement cron owns this session. Host site/user/runner/generation and both leases are checked on every effect.'),
            cron_tools: ['requirement_context', 'requirement_plan', 'requirement_progress', 'review_work', 'platform_key_provision', 'deployment_environment_sync', 'deployment_create'],
          } : {}),
          implemented: CAPABILITY_MANIFEST.implemented.map(entry => ({ ...entry, enabled: allowed.has(entry.name),
            availability: !allowed.has(entry.name) ? 'host_disabled' : entry.requirement_binding && !options.requirementId ? 'requirement_binding_required' : 'dependency_checked_on_call' })),
          separate_factory: CAPABILITY_MANIFEST.separate_factory.map(name => ({ name, enabled: allowed.has(name),
            provider: name === 'source_archive' ? 'runtime archive-tool' : 'runtime delivery-tools' })),
          unknown_allowed: [...allowed].filter(name => !Object.hasOwn(schemas, name) && !CAPABILITY_MANIFEST.separate_factory.includes(name)),
        }, redact) };
      } catch { return { ok: false, error: { code: 'SESSION_INACTIVE', message: 'Capability discovery requires an active session.' } }; }
    },
  }];
  for (const name of Object.keys(schemas) as CapabilityName[]) {
    if (!allowed.has(name)) continue;
    // zod schemas validate runtime arguments too; JSON schema exposes only our fixed capability inputs.
    tools.push({ name, description: descriptions[name], effect: readOnly.has(name) ? 'read' : 'write',
      parameters: zodToJsonSchema(schemas[name]) as Record<string, unknown>,
      async execute(rawArgs, context) {
        let started = false;
        try {
          const parsed = schemas[name].safeParse(rawArgs);
          if (!parsed.success) return unavailable('INVALID_ARGUMENTS', 'Arguments do not match this capability; model-supplied identifiers are forbidden.');
          const args = parsed.data as Record<string, unknown>;
          const req = await verify(context, requiresBinding(name));
          const assertCurrent = async () => { await verify(context, requiresBinding(name)); };
          const integration = { options, assertCurrent, signal: context.signal };
          const id = options.requirementId!;
          let result: unknown;
          started = true;
          switch (name) {
            case 'sandbox_db_provision': {
              const tenant = await deps.ensureTenant({ requirement_id: id, site_id: options.scope.siteId, user_id: options.scope.userId });
              secrets.add(tenant.jwt); // ensureTenant's legacy 7-day token is discarded, never configured.
              await assertCurrent();
              const token = await deps.issueTenantJWT({ tenant_id: tenant.tenant_id, schema: tenant.schema, user_id: options.scope.userId, expiresInSec: 900 });
              secrets.add(token.token);
              const config = await deps.publicConfig();
              const environment = { SUPABASE_URL: config.url, NEXT_PUBLIC_SUPABASE_URL: config.url,
                SUPABASE_ANON_KEY: config.anonKey, NEXT_PUBLIC_SUPABASE_ANON_KEY: config.anonKey,
                SUPABASE_SCHEMA: tenant.schema, SUPABASE_JWT: token.token,
                // Preserve existing Apps templates without writing their legacy .env files.
                NEXT_PUBLIC_APPS_SUPABASE_URL: config.url, NEXT_PUBLIC_APPS_SUPABASE_ANON_KEY: config.anonKey,
                NEXT_PUBLIC_APPS_TENANT_SCHEMA: tenant.schema, APPS_TENANT_JWT: token.token,
                APPS_AUTH_PROVIDER: tenant.auth_provider,
                ...(tenant.capabilities.storage.available ? { SUPABASE_STORAGE_BUCKET: tenant.capabilities.storage.bucket! } : {}) };
              await assertCurrent();
              if (options.saveEnvironment) await options.saveEnvironment('tenant', environment, {
                expiresAt: token.expires_at, refresh: { kind: 'tenant', requirementId: id },
              });
              else await options.configureEnvironment(environment);
              result = { provisioned: true, created: tenant.created, capabilities: tenant.capabilities,
                environment_names: Object.keys(environment), expires_at: token.expires_at,
                warning: 'Use runtime exec explicitly. Tenant credentials are RLS-constrained but visible to code sharing this VM. Storage availability is separate from DB success.' };
              break;
            }
            case 'sandbox_db_capabilities': result = await deps.tenantCapabilities(id); break;
            case 'sandbox_db_inspect': {
              const inspected = await deps.inspect(id, String(args.table_name)) as { success?: boolean; receipt?: unknown };
              if (!inspected?.success) return unavailable('DATABASE_INSPECTION_FAILED', 'Tenant table could not be inspected. Check provisioning and migrations.');
              result = { success: true, receipt: inspected.receipt }; break;
            }
            case 'sandbox_storage_ensure':
            case 'sandbox_storage_verify': {
              const binding = await deps.storageBinding(id, options.scope);
              await assertCurrent();
              if (name === 'sandbox_storage_ensure') result = await deps.ensureStorage(binding);
              else { await deps.verifyStorage(binding); result = { verified: true, bucket: binding.bucket }; }
              break;
            }
            case 'sandbox_db_migrate': result = await deps.migrate(integration, { requirementId: id,
              executionGeneration: req!.metadata?.requirement_execution_generation ?? 0,
              instance: { site_id: options.scope.siteId, user_id: options.scope.userId, requirement_id: id }, assertCurrent }); break;
            case 'sandbox_browser_install': await deps.installBrowser(integration); result = { installed: true }; break;
            default: result = await deps.legacy(name, args, integration);
          }
          const safe = safeJson(result, redact);
          const failure = result as { ok?: boolean; success?: boolean; errors?: unknown[]; error?: unknown } | null;
          if (failure && (failure.ok === false || failure.success === false || failure.errors?.length || failure.error)) {
            return { ok: false, output: safe, error: { code: 'CAPABILITY_FAILED', message: 'Integration returned a failure; inspect its receipt. No gate or lifecycle action was taken.' } };
          }
          return { ok: true, output: safe };
        } catch (error) {
          // Do not forward arbitrary dependency error text: it may embed platform secrets unknown to the redactor.
          return { ok: false, error: { code: error instanceof CapabilityError ? error.code : 'CAPABILITY_UNAVAILABLE',
            message: error instanceof CapabilityError ? redact(error.message) : 'Integration unavailable or interrupted. Host must inspect its configuration and dependency availability.',
            ...(started && !readOnly.has(name) ? { ambiguous: true } : {}) } };
        }
      },
    });
    // These are idempotent provider operations scoped to the same verified tenant.
    // Reconciliation rechecks ownership and the provider's current registry, not model claims.
    if (['sandbox_db_provision', 'sandbox_storage_ensure', 'sandbox_db_migrate'].includes(name)) {
      tools[tools.length - 1].reconcile = async (_args, context) => {
        await verify(context, true);
        try {
          const capabilities = await deps.tenantCapabilities(options.requirementId!);
          if (capabilities.requirement_id !== options.requirementId) return { state: 'unknown' };
          return { state: 'retry_safe', proof: `tenant:${capabilities.tenant_id}:idempotent:${name}` };
        } catch {
          // Provisioning has an atomic provider upsert by requirement ID. Missing
          // lookup never proves absence, but retrying that same operation is idempotent.
          if (name === 'sandbox_db_provision') return { state: 'retry_safe', proof: `apps_ensure_tenant:requirement:${options.requirementId}` };
          return { state: 'unknown' };
        }
      };
    }
  }
  return tools;
}

/** Refresh an EXISTING bound tenant's app credentials without provisioning again. */
export async function refreshTenantEnvironment(requirementId: string, scope: SessionScope,
  assertActive: () => Promise<void>, cronRun?: CapabilityOptions['cronRun']): Promise<{ values: Record<string, string>; expiresAt: string }> {
  await assertActive();
  const requirement = await defaults.loadRequirement(requirementId);
  if (!requirement || requirement.site_id !== scope.siteId || requirement.user_id !== scope.userId ||
    requirement.status !== 'in-progress' || (!cronRun && (requirement.cron_lock_active ||
    (requirement.cron_lock_expires_at && Date.parse(requirement.cron_lock_expires_at) > Date.now())))) {
    throw new Error('Tenant refresh binding unavailable');
  }
  const runner = requirement.metadata?.runner_instance_id ? await defaults.loadRunner(requirement.metadata.runner_instance_id) : null;
  if (!runner || runner.site_id !== scope.siteId || runner.user_id !== scope.userId ||
    (cronRun ? runner.id !== cronRun.instanceId || runner.status === 'paused' : runner.status !== 'paused') || runner.is_archived) {
    throw new Error('Tenant refresh owner unavailable');
  }
  const tenant = await defaults.storageBinding(requirementId, scope);
  const token = await defaults.issueTenantJWT({ tenant_id: tenant.tenantId, schema: tenant.schema, user_id: scope.userId, expiresInSec: 900 });
  await assertActive();
  return { values: { SUPABASE_JWT: token.token, APPS_TENANT_JWT: token.token }, expiresAt: token.expires_at };
}