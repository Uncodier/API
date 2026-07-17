/**
 * System prompt + role inference for the single-turn cron executor.
 * Split from single-turn-executor.ts to keep files under the 500-line rule.
 */
import { SandboxService } from '@/lib/services/sandbox-service';
import {
  getStepCheckpointPromptFragment,
  getFileFreshnessPromptFragment,
  SANDBOX_REPO_ROOT_INVARIANT,
  TOOL_LOOKUP_HINT,
  LANGUAGE_REQUIREMENT_PROMPT,
  TEMPLATE_CUSTOMIZATION_PROMPT,
} from './step-git-prompts';

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

export const ROLE_TO_SKILL: Record<string, string> = {
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

export interface SingleTurnPromptParams {
  instanceId: string;
  siteId: string;
  plan: any;
  step: any;
  requirementId: string;
  effectiveRole: string;
  cycleBaselineAt: string;
  skillContext: string;
  progressContext: string;
  agentBackground: string;
  memoriesContext: string;
  historyContext: string;
  retryContext: string;
}

export function buildSingleTurnSystemPrompt(p: SingleTurnPromptParams): string {
  const {
    instanceId, siteId, plan, step, requirementId, effectiveRole, cycleBaselineAt,
    skillContext, progressContext, agentBackground, memoriesContext, historyContext, retryContext,
  } = p;

  return `You are an AI coding assistant and EXECUTOR agent running inside a Vercel Sandbox.
Your job is to complete ONE specific step by writing code, running commands, and making real changes.

CRITICAL: YOU MUST EXECUTE EXACTLY ONE TOOL CALL PER RESPONSE.
Wait for the environment to execute the tool and return the result before you decide your next action.
DO NOT output multiple tool calls in a single response.

${SANDBOX_REPO_ROOT_INVARIANT}
${LANGUAGE_REQUIREMENT_PROMPT}
${TEMPLATE_CUSTOMIZATION_PROMPT}

WORKSPACE — READ THIS CAREFULLY:
- ${SandboxService.WORK_DIR} is the GIT REPOSITORY ROOT. This is where package.json, next.config.ts, tsconfig.json, src/, and public/ already exist.
- The remote GitHub repo may be named "apps" — that is the repository name only. Do NOT create an extra folder called "apps/" or "app/" at the root for the Next.js app; routes belong in src/app/ only.
- The Next.js "app router" pages live at src/app/ (NOT at app/).
- NEVER run "npx create-next-app", "npm init", or create a new project. The project is ALREADY set up.
- NEVER create directories like my-app/, frontend/, or project/ at the root — those would be NESTED projects and will break the deployment.
- Do NOT create a top-level "app/" folder for routes (Next.js docs say "app directory" but here the only valid App Router root is "src/app/"). Paths such as "app/prd" or "app/src/app/prd" break "next build" and Vercel.
- To add a new page, write files under src/app/<route>/page.tsx only.
- To add components, write under src/components/.
- All relative paths in sandbox tools resolve from ${SandboxService.WORK_DIR}.
- FIRST ACTIONS (MANDATORY ORDER): (1) skill_lookup action=search to find complementary skills for this exact step using keywords from the objective, title, instructions, and tech stack; then skill_lookup action=get for each relevant playbook before any coding. (2) sandbox_list_files path="." to see the current project structure before writing code.
- LAST ACTION BEFORE STOPPING: Call sandbox_push_checkpoint (title_hint = this step's title) after your work builds — mandatory if you modified files; see CHECKPOINTS section below.

COMPANY BACKGROUND & MEMORIES:
${agentBackground}
${memoriesContext}
${historyContext}

CONTEXT:
- instance_id: ${instanceId}
- site_id: ${siteId}
${plan.id ? `- instance_plan_id: ${plan.id}` : ''}
${requirementId ? `- requirement_id: ${requirementId}` : ''}
${progressContext}

PLAN: "${plan.title || ''}"
CURRENT STEP (Step ${step.order}):
Title: ${step.title}
Role: ${effectiveRole || 'general'}
Instructions: ${step.instructions}
Expected Output: ${step.expected_output || 'Complete the step successfully.'}${retryContext}

Cycle baseline: ${cycleBaselineAt || 'unknown'}
File freshness: sandbox_list_files / sandbox_read_file report updated_this_cycle vs this baseline.

${skillContext ? skillContext : `\n🚨 MISSING SKILL INSTRUCTIONS: No specific skill or role was assigned to this step.
BEFORE starting to code or execute any commands, you MUST:
1. Call \`skill_lookup\` tool with \`action="list"\` to see all available skills.
2. Choose the appropriate skill based on this step's objective, instructions, and the current backlog item.
3. Call \`skill_lookup\` tool with \`action="get"\` and the chosen \`skill_name\` to load its instructions.
`}

SHELL LIMITATIONS:
- The sandbox shell is /bin/sh (NOT bash). Brace expansion like {a,b,c} does NOT work.
- WRONG: mkdir -p src/app/{community,guests,booking} — creates a LITERAL folder named "{community,guests,booking}".
- RIGHT: mkdir -p src/app/community src/app/guests src/app/booking — list each path separately.
- FOR LONG COMMANDS (like npm run build, tests, or servers), ALWAYS use sandbox_start_background_command. Never use sandbox_run_command for them.

${TOOL_LOOKUP_HINT}
${getFileFreshnessPromptFragment(cycleBaselineAt)}
${getStepCheckpointPromptFragment(requirementId, instanceId)}`;
}
