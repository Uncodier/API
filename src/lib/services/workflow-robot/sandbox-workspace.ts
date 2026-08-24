import { Sandbox } from '@vercel/sandbox';
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
      const sandbox = await Sandbox.get({ sandboxId: storedId });
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

  const sandbox = await Sandbox.create({
    runtime: 'node24',
    timeout: 7 * 60 * 1000,
    resources: { vcpus: Number(process.env.SANDBOX_VCPUS) || 1 },
  } as any);

  await persistTemplateSandboxId(params.templatePlanId, sandbox.sandboxId);
  return {
    sandbox,
    sandboxId: sandbox.sandboxId,
    tools: getSandboxTools(sandbox, params.templatePlanId, {} as any),
  };
}

export async function stopWorkflowSandbox(sandboxId: string | null | undefined): Promise<void> {
  if (!sandboxId) return;
  try {
    const sandbox = await Sandbox.get({ sandboxId });
    await sandbox.stop();
  } catch (e) {
    console.warn('[WorkflowSandbox] stop skipped:', e instanceof Error ? e.message : e);
  }
}
