'use workflow';

import {
  createSandboxStep,
  cleanupNestedProjectsStep,
  commitAndPushStep,
  stopSandboxStep,
  extendRunLockStep,
  releaseRunLockStep,
} from '../shared/cron-steps';
import { runMaintenanceAgentStep } from './agent-step';
import { getBacklogSnapshotStep, unblockRequirementStep, checkInstanceAndPlanStatusStep, incrementQaSuccessfulRunsStep } from '../shared/workflow-db-steps';
import { buildMaintenancePromptForFlow } from './prompt';
import type { CronAuditContext } from '@/lib/services/cron-audit-log';
import { sleep } from 'workflow';

export interface MaintenanceWorkflowInput {
  reqId: string;
  title: string;
  instructions: string | null;
  type: string;
  site_id: string;
  user_id: string;
  instanceId: string;
  previousWorkContext: string;
  instance_type: string;
  cronLockRunId?: string;
  maintenanceLockKey: string;
}

export async function runMaintenanceWorkflow(input: MaintenanceWorkflowInput) {
  'use workflow';

  const { reqId, title, type, site_id, user_id, instanceId, cronLockRunId, maintenanceLockKey } = input;
  console.log(`[QAWorkflow] Starting QA & Improvement for req ${reqId}: ${title}`);

  const cronAudit: CronAuditContext = {
    instanceId,
    siteId: site_id,
    userId: user_id,
    requirementId: reqId,
  };

  let sandboxId: string | null = null;

  try {
    // Step 0: Check if instance or plan is paused
    let pausedCheck = await checkInstanceAndPlanStatusStep(instanceId);
    if (pausedCheck.isPaused) {
      console.log(`[QAWorkflow] Instance or plan is paused. Waiting for up to 5 minutes...`);
      for (let i = 0; i < 5; i++) {
        await sleep(60000); // 1 minute
        pausedCheck = await checkInstanceAndPlanStatusStep(instanceId);
        if (!pausedCheck.isPaused) {
          console.log(`[QAWorkflow] Resumed after ${i + 1} minutes.`);
          break;
        }
      }
      
      if (pausedCheck.isPaused) {
        console.log(`[QAWorkflow] Still paused after 5 minutes. Killing workflow and unblocking requirement.`);
        await unblockRequirementStep(reqId, true);
        return { reqId, status: 'paused' as const };
      }
    }

    const created = await createSandboxStep(reqId, type, title, cronAudit);
    sandboxId = created.sandboxId;
    const { branchName, workDir } = created;

    const cleanup = await cleanupNestedProjectsStep(sandboxId!, cronAudit);
    sandboxId = cleanup.effectiveSandboxId;

    const backlogSnap = await getBacklogSnapshotStep(reqId);
    const backlogSnapshot = backlogSnap.backlog;

    const maintenancePrompt = buildMaintenancePromptForFlow({
      reqId, title, type, instanceId, site_id,
      workDir, branchName, backlog: backlogSnapshot,
      previousWorkContext: input.previousWorkContext,
    });

    console.log(`[QAWorkflow|qa] Running QA & Improvement agent directly (no steps/plans)`);
    
    // Ejecutar las sondas visuales y E2E para obtener feedback de QA
    const { runGateProbesStep } = await import('../shared/step-gate-probes-step');
    const probes = await runGateProbesStep({
      sandboxId: sandboxId!,
      stepOrder: 0,
      requirementId: reqId,
      gitRepoKind: 'applications',
      audit: cronAudit,
      shouldRunVisual: true,
      stepContext: {
        title: 'QA Audit',
        instructions: 'Audit the entire application for visual defects, runtime errors, and E2E scenario failures.',
      },
      instanceType: type,
      title,
    });
    sandboxId = probes.effectiveSandboxId;

    let qaContext = '';
    if (probes.signals.visual?.defects?.length) {
      qaContext += `\nVISUAL DEFECTS FOUND:\n${probes.signals.visual.defects.map(d => `- [${d.severity}] ${d.route} (${d.viewport}): ${d.description} (Hint: ${d.fix_hint || 'N/A'})`).join('\n')}\n`;
    }
    if (probes.signals.console?.page_errors?.length) {
      qaContext += `\nBROWSER CONSOLE ERRORS:\n${probes.signals.console.page_errors.map(e => `- ${e.route}: ${e.message}`).join('\n')}\n`;
    }
    if (probes.signals.scenarios?.scenarios?.filter(s => !s.pass)?.length) {
      qaContext += `\nFAILED E2E SCENARIOS:\n${probes.signals.scenarios.scenarios.filter(s => !s.pass).map(s => `- ${s.scenario}: ${s.steps.find(st => !st.ok)?.error || 'Unknown error'}`).join('\n')}\n`;
    }

    const prompt = `Review the backlog for DONE items. Pick one to audit. Verify it ACTUALLY works as specified in the contract. If it's broken or missing pieces promised in the backlog item (e.g., a missing route), fix it. Then, refactor the code to improve quality (split files >500 lines, remove mocks). Update evidence/<item_id>.json with your fixes. Do NOT create an instance_plan. Just do the work and finish your turn.${qaContext ? `\n\nCRITICAL QA FEEDBACK TO FIX:\n${qaContext}` : ''}`;

    const agentRun = await runMaintenanceAgentStep({
      sandboxId: sandboxId!,
      reqId,
      requirementType: type,
      maintenancePrompt,
      instanceId,
      site_id,
      user_id,
      initialMessage: prompt,
      requirementTitle: title,
    });
    sandboxId = agentRun.effectiveSandboxId;

    await extendRunLockStep(maintenanceLockKey, cronLockRunId);

    if (!agentRun.timedOut) {
      const pushed = await commitAndPushStep(sandboxId!, title, reqId, 'QA & Improvement: Fixes and Refactoring', cronAudit, 'applications');
      if (pushed?.effectiveSandboxId) {
        sandboxId = pushed.effectiveSandboxId;
      }
      
      // Increment QA successful runs counter
      await incrementQaSuccessfulRunsStep(reqId);
    } else {
      console.log('[QAWorkflow|qa] Skipping commitAndPushStep — agent timed out');
    }

    // Unblock the requirement so the main builder can pick it up again
    // This is especially important if QA was triggered because the main builder was blocked
    await unblockRequirementStep(reqId, true);

    return { reqId, status: 'qa_improvement_cycle_complete' };
  } catch (e: any) {
    console.error(`[QAWorkflow] 🚨 CRITICAL ERROR in workflow for req ${reqId}:`, e);
    throw e;
  } finally {
    if (sandboxId) {
      try {
        await stopSandboxStep(sandboxId, cronAudit);
      } catch (e: unknown) {
        console.warn('[QAWorkflow] stopSandboxStep threw in finally:', e);
      }
    }
    await releaseRunLockStep(maintenanceLockKey, cronLockRunId);
  }
}
