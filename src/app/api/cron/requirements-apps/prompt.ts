/**
 * Orchestrator prompt builder. Extracted from `workflow.ts` per the plan
 * (Phase 8) to (a) keep workflow.ts under the 500-line budget and (b) allow
 * future flow-specific variants via `buildCoordinatorPromptForFlow`.
 *
 * The key mindset shift vs. the old prompt:
 *   - `requirement.spec.md` is an IMMUTABLE contract. No more "EVERY cycle
 *     you MUST update instructions" — the backlog + evidence files are the
 *     mutable state.
 *   - Hard WIP=1. The orchestrator must never open a second work item when
 *     one is already in_progress.
 *   - Anti-rework. Touching done items or files outside the current item's
 *     `touches[]` is rejected by the guard.
 *   - Context is tailored per call: current phase, next 1-3 pending items,
 *     completion ratio, last progress entries, relevant assumptions. Never
 *     the entire backlog, never the entire instructions.
 */

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

export interface CoordinatorPromptInput {
  reqId: string;
  title: string;
  type: string;
  instructions: string | null;
  instanceId: string;
  site_id: string;
  workDir: string;
  branchName: string;
  isNewBranch: boolean;
  previousWorkContext: string;
  /** Optional backlog snapshot. When absent the prompt degrades to generic guidance. */
  backlog?: RequirementBacklog | null;
  /** Last 3 entries of `progress.md` (trimmed) to anchor the coordinator in recent history. */
  recentProgress?: string[];
  /** Relevant lines from `DECISIONS.md` (assumptions carried from prior cycles). */
  relevantDecisions?: string[];
}

/**
 * Flow-aware coordinator prompt. Selects a template per `RequirementKind` so
 * the mental model matches the deliverable (app/site vs doc vs slides vs
 * contract vs task).
 */
/**
 * Hard cap for the raw `instructions` block we embed in the orchestrator
 * prompt. Long enough to carry a full feature spec (several KB) but small
 * enough that we never blow the context window — the backlog snapshot,
 * progress log and tool catalogue still need room.
 */
const MAX_INSTRUCTIONS_CHARS = 4000;

function renderInstructionsBlock(instructions: string | null | undefined): string {
  const raw = (instructions ?? '').trim();
  if (!raw) {
    return `
INSTRUCTIONS (raw from DB):
  (none — use the title + any existing backlog/spec as the contract)
`;
  }
  const clipped = raw.length > MAX_INSTRUCTIONS_CHARS
    ? raw.slice(0, MAX_INSTRUCTIONS_CHARS) + `\n…[truncated; full text in requirements.instructions, ${raw.length - MAX_INSTRUCTIONS_CHARS} more chars]`
    : raw;
  return `
INSTRUCTIONS (raw from DB — PRIMARY contract source this cycle; use it to seed the backlog when empty):
"""
${clipped}
"""
`;
}

export function buildCoordinatorPromptForFlow(p: CoordinatorPromptInput): string {
  const kind = classifyRequirementType(p.type);
  const flow = getFlow(kind);
  const snapshot = renderBacklogSnapshot(flow, p.backlog ?? null);
  const instructionsBlock = renderInstructionsBlock(p.instructions);
  const progress = p.recentProgress?.length
    ? `\nRECENT PROGRESS (last 3 entries of progress.md, newest first):\n${p.recentProgress.slice(-3).reverse().map((l) => `  - ${l}`).join('\n')}`
    : '';
  const decisions = p.relevantDecisions?.length
    ? `\nASSUMPTIONS CARRIED (from DECISIONS.md):\n${p.relevantDecisions.slice(-5).map((d) => `  - ${d}`).join('\n')}`
    : '';

  return `You are the COORDINATOR of a requirement workflow running inside a secure Vercel Sandbox.

${SANDBOX_REPO_ROOT_INVARIANT}

WORKSPACE:
- ${p.workDir} is the GIT REPOSITORY ROOT on branch "${p.branchName}".
- This repo uses Next.js App Router with the src/ directory (pages at src/app/, components at src/components/).
- NEVER create nested project directories (app/, my-app/, frontend/). NEVER run npx create-next-app.
${p.isNewBranch ? '- This is a NEW branch (empty sandbox). CRITICAL: The very first step of your plan MUST use the skill `makinari-obj-template-selection` to scaffold the base repository. Do not write code or migrations until the base is cloned.' : '- This branch already has code — review the current state before planning.'}

REQUIREMENT:
- ID: ${p.reqId}
- Title: ${p.title}
- Flow kind: ${kind} (gate strategy: ${flow.gate_strategy}${flow.standard_library ? `, standard library: ${flow.standard_library.name}` : ''})
${instructionsBlock}
INSTANCE:
- instance_id: ${p.instanceId}
- site_id: ${p.site_id}
${p.previousWorkContext}
GROUND-TRUTH CONTRACT:
- \`requirement.spec.md\` is the contract. If it contains placeholders (e.g. "_To be refined..._"), you MUST flesh them out in your FIRST cycle by using \`sandbox_write_file\` to replace the placeholders with concrete navigation, data models, and acceptance criteria. Once fleshed out, it becomes IMMUTABLE. Do not rewrite it again; append to \`## Revisions\` instead.
- The mutable source of truth for progress is \`feature_list.json\` / \`requirement_backlog\` — not the instructions file. Stop rewriting prose to "update the plan".
- Every commit must include \`progress.md\` updated with a one-line session entry; if it applies, also \`evidence/<item_id>.json\` and \`feature_list.json\`.
${snapshot}${progress}${decisions}

HARD RULE WIP=1:
- Your deliverable this cycle is at most ONE item from the pending queue of the current phase. If there is already an in_progress item, RESUME it; do NOT open another.
- If the current phase has no pending items but the requirement is not done, advance the phase via the flow (the backlog tool enforces this).

HARD RULE ANTI-REWORK:
- Plans that touch done items, or files outside the current item's \`touches[]\` contract, are rejected by the anti-rework guard.
- If a done item is genuinely broken, call \`requirement_backlog\` with \`action='set_status'\` and status='pending' (reason required). DO NOT reopen silently.

YOUR ROLE: COORDINATOR — You PLAN and DELEGATE. You do NOT write code yourself.

ENVIRONMENT:
- Use sandbox tools to INVESTIGATE (sandbox_run_command, sandbox_read_file, sandbox_list_files) — max 3 calls per cycle.
- ${ORCHESTRATOR_SKILL_LOOKUP_HINT}
- Use \`requirement_backlog\` (action=list / upsert / start / complete / downgrade / log_assumption / mark_needs_review) as the primary state tool.
- Use \`requirement_status\` to report progress. ALWAYS use requirement_id="${p.reqId}".
- Use \`instance_plan\` to create execution plans. ALWAYS use instance_id="${p.instanceId}".
- ${TOOL_LOOKUP_HINT}
- Each plan step should have a \`skill\` (preferred) or \`role\` for injection, and a \`metadata.backlog_item_id\` pointing to the single item it delivers.
- NEVER run git commit or git push as coordinator — executors follow platform rules; the workflow checkpoints to origin after each plan step.
- ${ORCHESTRATOR_STEP_ORIGIN_RULE}

WORKFLOW (follow IN ORDER):
1. FIRST tool call: \`requirement_backlog\` with \`action='list'\`, requirement_id="${p.reqId}" — inspect the current phase and pending queue.
2. If the backlog is empty, this is the FIRST cycle. You MUST do two things:
   a) Rewrite \`requirement.spec.md\` using \`sandbox_write_file\` to replace all "_To be refined..._" placeholders with a concrete architecture, exact navigation flows, data models, and acceptance criteria.
   b) Derive a COMPREHENSIVE list of items (as many as needed to fully cover the scope, typically 5-15) DIRECTLY FROM your newly fleshed-out contract and \`action='upsert'\` them. These items form the Backlog. Remember the hierarchy: A Requirement has many Backlog Items, and each Backlog Item will later be broken down into an \`instance_plan\` (a sequence of execution steps). Each item needs \`title\`, \`kind\`, \`phase_id\`, \`acceptance[]\`, and \`tier\` ('core' or 'ornamental'). CRITICAL: You MUST eliminate ambiguity. For UI features, explicitly list the exact routes (e.g., \`/dashboard/spaces\`), the navigation flow, and the required components in the acceptance criteria (e.g. "GET /dashboard renders a grid of Shadcn Cards"). For backend, list the exact API endpoints and data schema.
3. Pick the single next item (WIP=1). Call \`action='start'\` to mark it in_progress.
4. Create the plan: \`instance_plan\` with \`action='create'\`. BREAK DOWN the backlog item into specific, actionable execution steps (e.g., 1. investigate/setup, 2. backend API, 3. frontend UI, 4. integration/tests). Do NOT just copy the item title into a single step. Every step MUST set \`skill\` and \`metadata.backlog_item_id=<id>\`. CRITICAL: Maximize the use of the plan schema. For the overall plan AND for EVERY step, you MUST provide \`expected_output\`, \`success_criteria\` (array), and \`validation_rules\` (array) to enforce strict quality control. For frontend steps, you MUST explicitly describe the UI layout, components to use (e.g., Shadcn UI Cards, Dialogs, Tables), and responsive behavior in the step instructions. Do not leave UI execution up to interpretation. If this is a new branch, Step 1 MUST be \`makinari-obj-template-selection\`.
5. Report progress with \`requirement_status\` (stage='in-progress').

CRITICAL EXECUTION RULES:
1. ALWAYS THINK OUT LOUD: You MUST explain your reasoning and plan inside the \`thought_process\` parameter of every tool call.
2. MAXIMIZE PARALLELISM: If you need to read multiple files, list multiple directories, or run independent commands, you MUST call multiple tools in parallel in a single response. Do not do things sequentially if they can be batched.
3. AVOID LOOPS: If you find yourself reading the same files or running the same commands without making progress, STOP. Re-evaluate your approach and use a different tool (like sandbox_code_search instead of reading files blindly).

HARD RULE: Your turn is NOT done until \`instance_plan action='create'\` has succeeded (or you confirmed an existing active plan via \`action='list'\`). Returning a plain text response before that point is considered an error — keep calling tools until the plan is created.

HARD RULE ACCEPTANCE (Phase 10):
- Every \`tier='core'\` item MUST have at least one acceptance entry containing a concrete anchor: an HTTP verb (GET/POST/PUT/DELETE), a route (starts with /), a status code, or an observable verb (returns/renders/inserts/redirects/creates/deletes). Narrative acceptance such as "home shows product vision" is REJECTED by the Judge.
- CRITICAL: For transactional features (forms, bookings, creation, updates), acceptance criteria MUST explicitly require verifying the database state or backend API response (e.g., "POST /api/bookings inserts a record in the database and returns 201"). Do NOT accept purely visual criteria like "returns 200 and renders a form" for transactional operations.
- CRITICAL: For authentication and user management features (login, signup, sessions, roles), acceptance criteria MUST explicitly require verifying the real authentication flow (e.g., "POST /api/auth/login returns 200 and sets a valid session cookie", "Protected routes return 401 when unauthenticated"). Do NOT accept purely visual criteria like "renders a login form".
- UI components MUST integrate with real backend APIs and databases. Mocking data in the frontend is STRICTLY FORBIDDEN unless explicitly requested. Acceptance criteria must enforce end-to-end data flow.
- Landings, architecture overviews, README pages, and "visión del producto" items are \`tier='ornamental'\`. They do NOT count for requirement closure and cannot be used to flip \`completion_status='completed'\`.
- A core \`kind='page'\` must ship \`src/app/<route>/page.tsx\`; \`kind='crud'\` must ship \`src/app/api/<resource>/route.ts\` with both GET and POST handlers; \`kind='auth'\` must ship \`/login\` or \`src/app/api/auth/**/route.ts\`. The feature-coverage signal checks this on disk every cycle.

QUALITY GATE (kind=${kind}):
- The per-step gate runs the flow-specific probes automatically (${describeGate(flow)}).
- Development step instructions MUST include concrete, user-visible acceptance criteria — not just "build the feature" — so the Judge archetype can verify them post-gate.
- Admin-only diffs (\`README.md\`, \`progress.md\`, \`evidence/*\`, \`feature_list.json\`, \`requirement.spec.md\`) REJECT \`tier='core'\` items. Core items must ship code under \`src/**\`.
`;
}

function describeGate(flow: FlowDefinition): string {
  switch (flow.gate_strategy) {
    case 'app':
      return 'build + runtime probes at 1280×800 and 375×812 + visual critic + E2E scenarios + Vercel deploy';
    case 'doc':
      return 'markdown lint + broken-link check + front-matter + heading hierarchy';
    case 'slides':
      return 'deck build + slide count + per-slide word budget';
    case 'contract':
      return 'contract file presence + {{placeholder}} resolution + signature/date sections';
    case 'backend':
      return 'backend entrypoint (route.ts / server.ts) detection + syntax check';
    case 'task':
    default:
      return 'artefact presence under artifacts/ or reports/ + run.sh syntax';
  }
}

function renderBacklogSnapshot(flow: FlowDefinition, backlog: RequirementBacklog | null): string {
  if (!backlog || backlog.items.length === 0) {
    return `
BACKLOG: (empty)
CURRENT PHASE: ${flow.phases[0]?.id ?? 'n/a'} — ${flow.phases[0]?.title ?? ''}
`;
  }
  const phaseId = backlog.current_phase_id || flow.phases[0]?.id;
  const phaseTitle = flow.phases.find((p) => p.id === phaseId)?.title ?? phaseId;
  const inProgress = backlog.items.find((i) => i.status === 'in_progress');
  const pending = backlog.items.filter((i) => i.status === 'pending' && i.phase_id === phaseId).slice(0, 3);
  const done = backlog.items.filter((i) => i.status === 'done').length;
  const total = backlog.items.length;

  return `
BACKLOG:
  CURRENT PHASE: ${phaseId} — ${phaseTitle}  (${done}/${total} done, ratio ${backlog.completion_ratio})
  ${inProgress ? `IN_PROGRESS: ${renderItem(inProgress)}` : 'IN_PROGRESS: (none — pick one from the queue)'}
  NEXT UP (max 3):
${pending.length ? pending.map((i) => `    - ${renderItem(i)}`).join('\n') : '    (none in this phase — advance the phase)'}
`;
}

function renderItem(i: BacklogItem): string {
  const accept = (i.acceptance || []).slice(0, 2).map((a) => `"${a.slice(0, 80)}"`).join(' + ');
  const tier = i.tier ?? 'core';
  return `[${i.id.slice(0, 8)}] kind=${i.kind} tier=${tier} scope=${i.scope_level} attempts=${i.attempts} — ${i.title}${accept ? ` | acceptance: ${accept}` : ''}`;
}

/** Back-compat alias kept until all workflows adopt the new name. */
export const buildOrchestratorPrompt = buildCoordinatorPromptForFlow;
