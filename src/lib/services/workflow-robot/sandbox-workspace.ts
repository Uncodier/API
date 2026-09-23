import { Sandbox } from '@vercel/sandbox';
import { getSandboxHandle, sandboxIdentity } from '@/lib/services/sandbox-sdk';
import { buildSandboxCreateParams } from '@/lib/services/sandbox-create-params';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getSandboxTools } from '@/app/api/agents/tools/sandbox/assistantProtocol';
import { ensureWorkflowBrowserReady } from './browser';
import {
  normalizeWorkflowEnvironment,
  normalizeWorkflowSecretNames,
  selectWorkflowBrowserSecrets,
} from './environment';
import {
  workflowBrowserSession,
  workflowSandboxName,
} from './workspace-identity';
import { normalizeBrowserAllowedDomains } from './browser-domains';

export async function persistWorkflowRunSandboxId(runPlanId: string, sandboxId: string): Promise<void> {
  const { data, error: readError } = await supabaseAdmin
    .from('instance_plans')
    .select('metadata')
    .eq('id', runPlanId)
    .single();
  if (readError || !data) {
    throw new Error('Workflow run metadata could not be loaded.');
  }
  const metadata = { ...(data?.metadata || {}), active_sandbox_id: sandboxId };
  const { error: updateError } = await supabaseAdmin
    .from('instance_plans')
    .update({ metadata, updated_at: new Date().toISOString() })
    .eq('id', runPlanId);
  if (updateError) {
    throw new Error('Workflow run sandbox could not be persisted.');
  }
}

export async function ensureWorkflowSandbox(params: {
  runPlanId: string;
  title?: string;
  requiresBrowser?: boolean;
  browserAllowedDomains?: string[];
  browserSecretNames?: string[];
  instanceId?: string;
  siteId?: string;
}): Promise<{
  sandbox: Sandbox;
  sandboxId: string;
  tools: unknown[];
  environmentKeys: string[];
  browserReady: boolean;
}> {
  const { data: runPlan, error: runPlanError } = await supabaseAdmin
    .from('instance_plans')
    .select('metadata, instance_id, site_id')
    .eq('id', params.runPlanId)
    .single();
  if (runPlanError || !runPlan) {
    throw new Error('Workflow run plan could not be loaded.');
  }

  const instanceId = params.instanceId || runPlan?.instance_id;
  if (!instanceId) {
    throw new Error('Workflow instance ID is missing.');
  }
  const { data: instance, error: instanceError } = await supabaseAdmin
    .from('remote_instances')
    .select('environment_variables')
    .eq('id', instanceId)
    .single();
  if (instanceError || !instance) {
    throw new Error('Workflow instance environment could not be loaded.');
  }
  const environment = normalizeWorkflowEnvironment(instance.environment_variables);
  const requestedSecretNames = Array.isArray(params.browserSecretNames)
    ? params.browserSecretNames
    : [];
  if (requestedSecretNames.some(
    (name) => normalizeWorkflowSecretNames([name]).length === 0,
  )) {
    throw new Error('browser_secret_names contains an invalid variable name.');
  }
  const {
    secrets: browserSecrets,
    missing: missingBrowserSecrets,
  } = selectWorkflowBrowserSecrets(environment, requestedSecretNames);
  if (missingBrowserSecrets.length > 0) {
    throw new Error(
      `Browser credential variables are not configured: ${missingBrowserSecrets.join(', ')}.`,
    );
  }
  const requestedBrowserDomains = Array.isArray(params.browserAllowedDomains)
    ? params.browserAllowedDomains
    : [];
  const invalidBrowserDomains = requestedBrowserDomains.filter(
    (domain) => normalizeBrowserAllowedDomains([domain]).length === 0,
  );
  if (invalidBrowserDomains.length > 0) {
    throw new Error('browser_allowed_domains contains an invalid domain pattern.');
  }
  const browserAllowedDomains = normalizeBrowserAllowedDomains(
    requestedBrowserDomains,
  );
  if (
    params.requiresBrowser &&
    Object.keys(browserSecrets).length > 0 &&
    browserAllowedDomains.length === 0
  ) {
    throw new Error(
      'Browser credentials are configured, but browser_allowed_domains is empty.',
    );
  }
  const toolsContext = {
    site_id: params.siteId || runPlan?.site_id,
    instance_id: instanceId,
    browser_enabled: params.requiresBrowser === true,
    browser_session: workflowBrowserSession(params.runPlanId),
    browser_allowed_domains: browserAllowedDomains,
  };
  const buildResult = (sandbox: Sandbox, sandboxId: string) => ({
    sandbox,
    sandboxId,
    tools: getSandboxTools(
      sandbox,
      undefined,
      toolsContext,
      params.requiresBrowser ? browserSecrets : undefined,
    ),
    environmentKeys: params.requiresBrowser ? Object.keys(browserSecrets).sort() : [],
    browserReady: params.requiresBrowser === true,
  });

  const storedId = (runPlan?.metadata as { active_sandbox_id?: string } | null)?.active_sandbox_id;
  if (storedId) {
    let sandbox: Sandbox | null = null;
    try {
      sandbox = await getSandboxHandle(storedId);
    } catch {
      console.warn(`[WorkflowSandbox] Stored sandbox ${storedId} is gone; creating a new one`);
    }
    if (sandbox) {
      if (params.requiresBrowser) {
        await ensureWorkflowBrowserReady(
          sandbox,
          browserAllowedDomains,
        );
      }
      return buildResult(sandbox, storedId);
    }
  }

  const browserSnapshotId = params.requiresBrowser
    ? process.env.AGENT_BROWSER_SNAPSHOT_ID?.trim()
    : undefined;
  const sandbox = await Sandbox.create(buildSandboxCreateParams({
    name: workflowSandboxName(params.runPlanId),
    snapshotId: browserSnapshotId || undefined,
    exposePreviewPort: false,
    persistent: true,
    tags: { kind: 'workflow-robot' },
    networkPolicy: params.requiresBrowser ? 'allow-all' : undefined,
    coldCreate: !browserSnapshotId,
  }) as Record<string, unknown>);

  const sandboxId = sandboxIdentity(sandbox);
  await persistWorkflowRunSandboxId(params.runPlanId, sandboxId);
  try {
    if (params.requiresBrowser) {
      await ensureWorkflowBrowserReady(
        sandbox,
        browserAllowedDomains,
      );
    }
  } catch (error) {
    await sandbox.stop().catch(() => undefined);
    throw error;
  }
  return buildResult(sandbox, sandboxId);
}

export async function stopWorkflowSandbox(sandboxId: string | null | undefined): Promise<void> {
  if (!sandboxId) return;
  try {
    const sandbox = await getSandboxHandle(sandboxId);
    await sandbox.stop();
  } catch (e) {
    console.warn('[WorkflowSandbox] stop skipped:', e instanceof Error ? e.message : e);
  }
}
