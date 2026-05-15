'use workflow';

import {
  createSandboxStep,
  cleanupNestedProjectsStep,
  commitAndPushStep,
  stopSandboxStep,
} from '@/app/api/cron/shared/cron-steps';
import { runUpdateRepoAgentStep } from './agent-step';
import type { CronAuditContext } from '@/lib/services/cron-audit-log';

export interface UpdateRepoWorkflowInput {
  reqId: string;
  title: string;
  instruction: string;
  type: string;
  site_id: string;
  user_id: string;
  instanceId: string;
}

export async function runUpdateRepoWorkflow(input: UpdateRepoWorkflowInput) {
  'use workflow';

  const { reqId, title, type, instruction, site_id, user_id, instanceId } = input;
  console.log(`[UpdateRepoWorkflow] Starting update for req ${reqId}: ${title}`);

  const cronAudit: CronAuditContext = {
    instanceId,
    siteId: site_id,
    userId: user_id,
    requirementId: reqId,
  };

  let sandboxId: string | null = null;

  try {
    // Step 1: Create or reuse Sandbox
    const created = await createSandboxStep(reqId, type, title, cronAudit);
    sandboxId = created.sandboxId;

    // Step 2: Cleanup nested projects if any
    const cleanup = await cleanupNestedProjectsStep(sandboxId!, cronAudit);
    sandboxId = cleanup.effectiveSandboxId;

    console.log(`[UpdateRepoWorkflow] Running update_repo agent directly`);
    
    // Step 3: Run the Agent to execute the instruction
    let agentRun;
    try {
      agentRun = await runUpdateRepoAgentStep({
        sandboxId: sandboxId!,
        reqId,
        requirementType: type,
        instruction,
        instanceId,
        site_id,
        user_id,
        requirementTitle: title,
      });
    } catch (error: any) {
      console.warn(`[UpdateRepoWorkflow] runUpdateRepoAgentStep failed:`, error);
      agentRun = {
        timedOut: true,
        effectiveSandboxId: sandboxId!,
      };
    }
    sandboxId = agentRun.effectiveSandboxId;

    // Step 4: Commit and Push (if agent didn't time out or if it modified files)
    if (!agentRun.timedOut) {
      const pushed = await commitAndPushStep(
        sandboxId!, 
        title, 
        reqId, 
        `Update Repo: executed tool instruction`, 
        cronAudit, 
        type === 'automation' ? 'automation' : 'applications'
      );
      
      if (pushed?.effectiveSandboxId) {
        sandboxId = pushed.effectiveSandboxId;
      }
      
      if (pushed && !pushed.pushed) {
        console.log('[UpdateRepoWorkflow] commitAndPushStep returned false (no changes to push or failed).');
      }
    } else {
      console.log('[UpdateRepoWorkflow] Skipping commitAndPushStep — agent timed out');
    }

    return { reqId, status: 'update_repo_complete' };
  } catch (e: any) {
    console.error(`[UpdateRepoWorkflow] 🚨 CRITICAL ERROR in workflow for req ${reqId}:`, e);
    throw e;
  } finally {
    if (sandboxId) {
      try {
        await stopSandboxStep(sandboxId, cronAudit);
      } catch (e: unknown) {
        console.warn('[UpdateRepoWorkflow] stopSandboxStep threw in finally:', e);
      }
    }
  }
}
