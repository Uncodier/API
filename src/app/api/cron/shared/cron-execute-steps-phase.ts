import { runOrchestratorStep } from './cron-orchestrator-step';

export type PlanExecutionHaltReason =
  | 'paused'
  | 'cancelled'
  | 'terminal'
  | 'missing';

export function buildPlanAdaptationUserMessage(
  requirementTitle: string,
  requirementId: string,
  planId: string,
  failingStep: any,
  gateErrorText: string,
): string {
  const excerpt = gateErrorText.slice(0, 3000);
  return `The current plan step \`${failingStep.title}\` (ID: ${failingStep.id}) has repeatedly failed validation and cannot be completed locally.
  
  Requirement: ${requirementTitle}
  Failing Step Objective: ${failingStep.instructions}
  
  --- FINAL VALIDATION ERROR ---
  ${excerpt}
  
  --- ORCHESTRATOR INSTRUCTIONS ---
  You MUST adapt the \`instance_plan\` (ID: ${planId}) to work around this roadblock.
  1. Call \`sandbox_read_file\` or \`sandbox_run_command\` to investigate the failure if you need more context.
  2. Use the \`instance_plan\` tool (action='update') to modify the plan.
     - You CANNOT delete or modify steps that are already 'completed'.
     - You CAN mark the failing step as 'cancelled' if it's fundamentally unachievable, and add alternative steps instead.
     - You CAN append new steps to break down the failing step into smaller pieces.
     - You CAN modify pending steps that depend on the failing step.
  3. Respond describing the changes you made to the plan.`;
}

export type PlanGate =
  | { runnable: true; dbStatus: string }
  | { runnable: false; reason: PlanExecutionHaltReason };

import { 
  getPlanExecutionGateFromStatus, 
  getPlanExecutionGateStep, 
  updatePlanStepStatusStep, 
  reconnectSandboxStep, 
  logCronInfrastructureEventStep,
  recordStepInfraTransientStep
} from './cron-execute-steps-phase-helpers';

export {
  getPlanExecutionGateFromStatus, 
  getPlanExecutionGateStep, 
  updatePlanStepStatusStep, 
  reconnectSandboxStep, 
  logCronInfrastructureEventStep,
  recordStepInfraTransientStep
};

export type ExecuteStepsPhaseResult = any;
export async function executeStepsPhaseStep(params: any): Promise<ExecuteStepsPhaseResult> { return {}; }
export async function runGateForStepWrapperStep(params: any): Promise<any> { return {}; }
export async function adaptPlanStepWrapperStep(params: any): Promise<any> { return {}; }
