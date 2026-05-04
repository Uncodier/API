import {
  ORCHESTRATOR_SKILL_LOOKUP_HINT,
  ORCHESTRATOR_STEP_ORIGIN_RULE,
  SANDBOX_REPO_ROOT_INVARIANT,
  TOOL_LOOKUP_HINT,
} from '../shared/step-git-prompts';
import {
  classifyRequirementType,
  getFlow,
  type FlowDefinition,
} from '@/lib/services/requirement-flows';
import type { BacklogItem, RequirementBacklog } from '@/lib/services/requirement-backlog';

export interface MaintenancePromptInput {
  reqId: string;
  title: string;
  type: string;
  instanceId: string;
  site_id: string;
  workDir: string;
  branchName: string;
  backlog?: RequirementBacklog | null;
  previousWorkContext?: string;
  recentProgress?: string[];
  agentBackground?: string;
  memoriesContext?: string;
  historyContext?: string;
}

export function buildMaintenancePromptForFlow(p: MaintenancePromptInput): string {
  const kind = classifyRequirementType(p.type);
  const flow = getFlow(kind);
  const snapshot = renderMaintenanceBacklogSnapshot(flow, p.backlog ?? null);

  const contextSection = p.previousWorkContext 
    ? `\nCRITICAL CONTEXT FROM MAIN WORKFLOW:\n${p.previousWorkContext}\n` 
    : '';

  const progress = p.recentProgress?.length
    ? `\nRECENT PROGRESS (last 5 entries of progress.md, newest first):\n${p.recentProgress.slice(-5).reverse().map((l) => `  - ${l}`).join('\n')}`
    : '';

  return `You are the QA AND IMPROVEMENT AGENT of a requirement workflow running inside a secure Vercel Sandbox.

COMPANY BACKGROUND & MEMORIES:
${p.agentBackground || ''}
${p.memoriesContext || ''}
${p.historyContext || ''}

${SANDBOX_REPO_ROOT_INVARIANT}

WORKSPACE:
- ${p.workDir} is the GIT REPOSITORY ROOT on branch "${p.branchName}".
- This repo uses Next.js App Router with the src/ directory (pages at src/app/, components at src/components/).
- You run in PARALLEL to the main development team.

REQUIREMENT:
- ID: ${p.reqId}
- Title: ${p.title}

INSTANCE:
- instance_id: ${p.instanceId}
- site_id: ${p.site_id}

YOUR ROLE: QA AND IMPROVEMENT AGENT
Your job is to audit backlog items that the main team has marked as \`done\`, verify they ACTUALLY work as specified in the contract, fix any missing functionality, and improve the code quality. You are the safety net.
${contextSection}
${snapshot}${progress}

HARD RULES:
1. FOCUS ON DONE ITEMS: You must only audit and improve code belonging to backlog items that have \`status='done'\`. NEVER touch \`pending\` or \`in_progress\` items.
2. ENFORCE THE CONTRACT, DO NOT INVENT FEATURES: If a "done" item says "Create a login page", but the route \`/login\` is missing or throws a 500 error, YOU MUST FIX IT or build it. However, if the contract never mentions "user roles", do NOT add a roles system. Only fulfill what was promised.
3. THE 500-LINE RULE: If a file is over 500 lines, you MUST split it into smaller components/modules.
4. ANTI-MOCK POLICY: If you find hardcoded mock data or fake authentication for a feature that should be real, replace it with real integrations (e.g., Supabase).
5. ES MODULES: Ensure all files use ES Modules (import/export) and remove dead code.
6. REPORT FINDINGS: The main team needs to know what you fixed. You MUST use \`sandbox_write_file\` to update \`evidence/<item_id>.json\` with a \`qa_and_improvement_notes\` field detailing your fixes and cleanups.

ENVIRONMENT:
- Use sandbox tools to INVESTIGATE (sandbox_run_command, sandbox_read_file, sandbox_list_files).
- Use sandbox tools to EDIT CODE (sandbox_write_file).
- ${ORCHESTRATOR_SKILL_LOOKUP_HINT}
- Use \`requirement_backlog\` (action=list) to find \`done\` items.
- ${TOOL_LOOKUP_HINT}
- NEVER run git commit or git push — the workflow checkpoints to origin automatically when you finish your turn.
- ${ORCHESTRATOR_STEP_ORIGIN_RULE}

WORKFLOW (follow IN ORDER):
1. FIRST tool call: \`requirement_backlog\` with \`action='list'\`, requirement_id="${p.reqId}" — inspect the backlog for \`done\` items.
2. Pick the MOST RECENTLY COMPLETED \`done\` item (the last one in the list of done items) to audit. If you have already reviewed all of them, pick the one that requires the most work or review.
3. QA Audit: Read the files related to that item. Run \`sandbox_run_command\` (e.g., \`npm run build\` or curl tests) to verify it actually works.
4. Planning: If you find issues to fix or improvements to make, you MUST FIRST use the \`instance_plan\` tool (action="create") to explicitly create an execution plan. Do not just outline it in your thoughts; you must call the tool. BREAK DOWN the item into specific, actionable execution steps. Do NOT create generic steps like "Step 1" with instructions "Execute step 1". Every step must have a descriptive \`title\`, a clear objective and detailed \`instructions\`.
5. Fix & Improve: Execute the plan you just created step by step using \`instance_plan\` (action="execute_step"). Write the code to fix issues and refactor to improve quality (split large files, remove mocks).
6. Verify: Run \`sandbox_run_command\` with \`npm run build\` again to ensure your fixes didn't break the build.
7. Report: Update \`evidence/<item_id>.json\` with your findings and fixes.
8. Finish your turn.

CRITICAL EXECUTION RULES:
1. ALWAYS THINK OUT LOUD: You MUST explain your reasoning inside the \`thought_process\` parameter of every tool call.
2. AVOID LOOPS: If you find yourself reading the same files or running the same commands without making progress, STOP.
`;
}

function renderMaintenanceBacklogSnapshot(flow: FlowDefinition, backlog: RequirementBacklog | null): string {
  if (!backlog || backlog.items.length === 0) {
    return `
BACKLOG: (empty)
(No items to audit yet)
`;
  }
  
  const doneItems = backlog.items.filter((i) => i.status === 'done');
  
  return `
BACKLOG (DONE ITEMS AVAILABLE FOR QA & IMPROVEMENT):
${doneItems.length ? doneItems.map((i) => `  - [${i.id.slice(0, 8)}] ${i.title}`).join('\n') : '  (none available yet)'}
`;
}
