import { Sandbox } from '@vercel/sandbox';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { executeAssistantStep } from '@/lib/services/robot-instance/assistant-executor';
import { getAssistantTools } from '@/app/api/robots/instance/assistant/utils';
import { updateInstancePlanCore } from '@/app/api/agents/tools/instance_plan/update/route';
import { fetchStepLogHistoryText } from './step-history-builder';
import { SkillsService } from '@/lib/services/skills-service';
import { connectOrRecreateRequirementSandbox } from '@/lib/services/sandbox-recovery';
import { CronInfraEvent, logCronInfrastructureEvent, type CronAuditContext } from '@/lib/services/cron-audit-log';
import type { GitRepoKind } from './cron-commit-helpers';
import type { RequirementKind } from '@/lib/services/requirement-flows';
import { isSandboxGoneError } from '@/lib/services/sandbox-gone-error';

export function inferRoleFromStep(step: any): string | null {
  const text = `${step.title || ''} ${step.instructions || ''}`.toLowerCase();
  if (
    /template|vitrina|vitrinas|bootstrap|project base|base branch|select.*repo|checkout.*origin/.test(
      text,
    )
  ) {
    return 'template_selection';
  }
  if (/deploy|ci\/cd|build|push|docker|nginx|vercel|infra|devops|smoke.?test/.test(text)) return 'devops';
  if (/\bqa\b|quality\s*assurance|e2e|end.?to.?end|test\s*author|scenario/.test(text)) return 'qa';
  if (/css|ui|ux|component|page|layout|style|tailwind|react|html|responsive|frontend/.test(text)) return 'frontend';
  if (/api|endpoint|database|migration|server|auth|backend|supabase/.test(text)) return 'backend';
  if (/readme|copy|blog|seo|content|text|docs/.test(text)) return 'content';
  if (/investigat|research|audit|analyz|review/.test(text)) return 'investigate';
  if (/valid|test|check|verify|lint/.test(text)) return 'validate';
  return 'frontend'; // default for app requirements
}

const ROLE_TO_SKILL: Record<string, string> = {
  'template_selection': 'makinari-obj-template-selection',
  'frontend': 'makinari-rol-frontend',
  'backend': 'makinari-rol-backend',
  'devops': 'makinari-rol-devops',
  'content': 'makinari-rol-content',
  'orchestrator': 'makinari-rol-orchestrator',
  'qa': 'makinari-rol-qa',
  'investigate': 'makinari-fase-investigacion',
  'plan': 'makinari-fase-planeacion',
  'validate': 'makinari-fase-validacion',
  'report': 'makinari-fase-reporteado',
};

export interface SingleTurnResult {
  ok: boolean;
  isDone: boolean;
  error?: string;
  effectiveSandboxId: string;
}

export async function executeSingleTurnStep(params: {
  sandboxId: string;
  plan: any;
  step: any;
  requirementId: string;
  instanceId: string;
  siteId: string;
  userId?: string;
  title: string;
  gitRepoKind: GitRepoKind;
  requirementType: string;
}): Promise<SingleTurnResult> {
  'use step';
  const { sandboxId, plan, step, requirementId, instanceId, siteId, userId, title, gitRepoKind, requirementType } = params;
  
  const audit: CronAuditContext = {
    instanceId: instanceId,
    siteId: siteId,
    userId: userId,
    requirementId: requirementId,
  };

  // 1. Connect to Sandbox
  const instanceType = gitRepoKind === 'automation' ? 'automation' : 'applications';
  let connected;
  try {
    connected = await connectOrRecreateRequirementSandbox({
      sandboxId,
      requirementId,
      instanceType,
      title,
      audit,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, isDone: false, error: msg, effectiveSandboxId: sandboxId };
  }
  let sandbox = connected.sandbox;
  let effectiveSandboxId = connected.sandboxId;

  // 2. Mark step in_progress if pending
  try {
    const { data: planRow } = await supabaseAdmin
      .from('instance_plans')
      .select('steps, status')
      .eq('id', plan.id)
      .maybeSingle();
      
    const freshStep = Array.isArray(planRow?.steps) ? planRow.steps.find((s: any) => s.id === step.id) : undefined;
    if (freshStep && (freshStep.status === 'completed' || freshStep.status === 'cancelled')) {
      console.log(`[SingleTurn] Step ${step.order} already ${freshStep.status}.`);
      return { ok: true, isDone: true, effectiveSandboxId };
    }
  } catch (e) {}

  await updateInstancePlanCore({
    plan_id: plan.id, instance_id: instanceId, site_id: siteId,
    steps: [{ id: step.id, status: 'in_progress', started_at: new Date().toISOString() }],
  });

  // 3. Build Prompt & Context
  const effectiveRole = step.role || inferRoleFromStep(step) || 'general';
  const skillName = step.skill || (effectiveRole && ROLE_TO_SKILL[effectiveRole]);
  let skillContext = '';
  if (skillName) {
    const matched = SkillsService.getSkillBySlugOrName(skillName);
    if (matched) skillContext = `\n\n--- SKILL INSTRUCTIONS: ${matched.name} ---\n${matched.content}\n--- END SKILL ---\n`;
  }

  const systemPrompt = `You are an AI coding assistant.
Your task is to execute plan step ${step.order}: ${step.title}
Instructions: ${step.instructions}

CRITICAL: YOU MUST EXECUTE EXACTLY ONE TOOL CALL PER RESPONSE.
Wait for the environment to execute the tool and return the result before you decide your next action.
DO NOT output multiple tool calls in a single response.${skillContext}`;

  // 4. Fetch History
  const historyText = await fetchStepLogHistoryText(instanceId, plan.id, step.id);
  const messages = [
    { role: 'user' as const, content: `Execute step ${step.order}: ${step.title}. ${step.instructions}` },
  ];

  if (historyText) {
    messages.push({
      role: 'user' as const,
      content: `${historyText}\n\nReview the previous actions including any gate failures. Decide the next single tool call to advance the step, or finish the step if completed. REMEMBER: MAXIMUM 1 TOOL CALL.`
    });
  }

  // 5. Call Executor (Max 1 turn)
  const fullTools = getAssistantTools(siteId, userId, instanceId, []);
  
  try {
    const result = await executeAssistantStep(messages, { id: instanceId }, {
      instance_id: instanceId,
      site_id: siteId,
      user_id: userId,
      plan_id: plan.id,
      step_id: step.id,
      system_prompt: systemPrompt,
      custom_tools: fullTools,
      enforceSingleTurn: true // CRITICAL: enforce 1 tool call max per invocation
    });
    
    // Check if the LLM attempted to execute tools and failed due to sandbox gone
    const hasSandboxGoneError = result.messages?.some((m: any) => 
      m.role === 'tool' && isSandboxGoneError(typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
    );
    
    if (hasSandboxGoneError) {
       console.warn(`[SingleTurn] Sandbox gone detected. Will retry next workflow cycle.`);
       return { ok: false, isDone: false, error: 'Sandbox Gone 410', effectiveSandboxId };
    }

    return { ok: true, isDone: result.isDone, effectiveSandboxId };
  } catch (e: any) {
    console.error('[SingleTurn] Executor failed:', e);
    return { ok: false, isDone: false, error: e.message, effectiveSandboxId };
  }
}
