import { Sandbox } from '@vercel/sandbox';
import { getSandboxHandle, sandboxIdentity } from '@/lib/services/sandbox-sdk';
import { buildSandboxCreateParams } from '@/lib/services/sandbox-create-params';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getSandboxTools } from '@/app/api/agents/tools/sandbox/assistantProtocol';

export async function persistTemplateSandboxId(templatePlanId: string, sandboxId: string): Promise<void> {
  const { data } = await supabaseAdmin
    .from('instance_plans')
    .select('metadata')
    .eq('id', templatePlanId)
    .single();
  const metadata = { ...(data?.metadata || {}), active_sandbox_id: sandboxId };
  await supabaseAdmin
    .from('instance_plans')
    .update({ metadata, updated_at: new Date().toISOString() })
    .eq('id', templatePlanId);
}

export async function ensureWorkflowSandbox(params: {
  templatePlanId: string;
  title?: string;
}): Promise<{ sandbox: Sandbox; sandboxId: string; tools: unknown[] }> {
  const { data: template } = await supabaseAdmin
    .from('instance_plans')
    .select('metadata')
    .eq('id', params.templatePlanId)
    .single();

  const storedId = (template?.metadata as { active_sandbox_id?: string } | null)?.active_sandbox_id;
  if (storedId) {
    try {
      const sandbox = await getSandboxHandle(storedId);
      return {
        sandbox,
        sandboxId: storedId,
        tools: getSandboxTools(sandbox, params.templatePlanId, {
          instance_id: undefined,
        } as any),
      };
    } catch {
      console.warn(`[WorkflowSandbox] Stored sandbox ${storedId} is gone; creating a new one`);
    }
  }

  const sandbox = await Sandbox.create(buildSandboxCreateParams({
    name: `wf-${String(params.templatePlanId).replace(/[^a-f0-9-]/gi, '').slice(0, 8)}`,
    exposePreviewPort: false,
    persistent: true,
    tags: { kind: 'workflow-robot' },
  }) as Record<string, unknown>);

  await persistTemplateSandboxId(params.templatePlanId, sandboxIdentity(sandbox));
  return {
    sandbox,
    sandboxId: sandboxIdentity(sandbox),
    tools: getSandboxTools(sandbox, params.templatePlanId, {} as any),
  };
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
