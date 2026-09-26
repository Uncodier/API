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
  LANGUAGE_REQUIREMENT_PROMPT,
  TEMPLATE_CUSTOMIZATION_PROMPT,
  SUPABASE_ENVIRONMENT_PROMPT,
} from '../shared/step-git-prompts';
import {
  classifyRequirementType,
  getFlow,
  type FlowDefinition,
} from '@/lib/services/requirement-flows';
import { extractRequirementConstraints, formatConstraintsPromptBlock } from '@/lib/services/requirement-constraints';
import type { BacklogItem, RequirementBacklog } from '@/lib/services/requirement-backlog';
import { isBacklogItemRunnable } from '@/lib/services/requirement-backlog-blockers';

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
  agentBackground?: string;
  memoriesContext?: string;
  historyContext?: string;
  provisionedEnvKeys?: string[];
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
  const constraintBlock = formatConstraintsPromptBlock(extractRequirementConstraints(
    p.instructions,
    ...(p.backlog?.items || []).flatMap((i) => [...(i.constraints || []), ...(i.acceptance || [])]),
  ));
  const progress = p.recentProgress?.length
    ? `\nRECENT PROGRESS (last 3 entries of progress.md, newest first):\n${p.recentProgress.slice(-3).reverse().map((l) => `  - ${l}`).join('\n')}`
    : '';
  const decisions = p.relevantDecisions?.length
    ? `\nASSUMPTIONS CARRIED (from DECISIONS.md):\n${p.relevantDecisions.slice(-5).map((d) => `  - ${d}`).join('\n')}`
    : '';

  const phaseId = p.backlog?.current_phase_id || flow.phases[0]?.id;
  const isQaPhase = phaseId === 'qa';
  const isBuildPhase = phaseId === 'build';

  const breakdownInstruction = isQaPhase
    ? `Since this is the QA phase, you MUST break down the instance_plan into exactly 7 strict execution steps in this specific order:
      1. "Static Repository Integrity & Cleanup" (Clean dummy files, review variables/naming)
      2. "Dependency & Build Audit" (Verify npm build passes, check dependencies)
      3. "Linter & Static Analysis" (Run ESLint/Prettier, check code standards)
      4. "Static Broken Links Audit" (Run the static link checker script to evaluate link states)
      5. "Unit & Integration Test Audit" (Verify existing tests pass)
      6. "Feature E2E & Contract Validation" (Validate the specific backlog item, write scenarios, assert acceptance criteria)
      7. "Runtime Error & Log Audit" (Inspect server and browser logs for hidden exceptions, hydration errors, or unhandled promises after tests).
      Assign the \`makinari-rol-qa\` skill to ALL 7 steps.`
    : isBuildPhase
      ? `BREAK DOWN the backlog item into implementation and verification steps (for example: backend/API, frontend/UI, integration/tests). Do not create a standalone investigation step; include bounded repository inspection in the first implementation step.`
      : `BREAK DOWN the backlog item into specific, actionable execution steps appropriate to the current ${phaseId} phase.`;

  const { isBacklogComplete, hasOutstandingWork } = require('@/lib/services/requirement-backlog');
  const isComplete = p.backlog?.items && isBacklogComplete(p.backlog.items);
  const hasWork = p.backlog?.items && hasOutstandingWork(p.backlog.items);

  const closureBlock = (isComplete && !hasWork)
    ? `BACKLOG COMPLETO. Tu única acción válida este ciclo:
- Llamar requirement_status stage='on-review' con message='Project complete'.
- Responder texto plano "Project delivered."
- NO crear items, NO crear planes, NO llamar requirement_backlog upsert.
Cualquier otra herramienta será rechazada por el guard.`
    : `HARD RULE: Your turn is NOT done until \`instance_plan action='create'\` has succeeded (or you confirmed an existing active plan via \`action='list'\`). Returning a plain text response before that point is considered an error — keep calling tools until the plan is created. CRITICAL: You still have pending items in the backlog. You are strictly forbidden from calling \`requirement_status\` to close the project.`;

  return `You are the COORDINATOR of a requirement workflow running inside a secure Vercel Sandbox.

COMPANY BACKGROUND & MEMORIES:
${p.agentBackground || ''}
${p.memoriesContext || ''}
${p.historyContext || ''}

${SANDBOX_REPO_ROOT_INVARIANT}
${LANGUAGE_REQUIREMENT_PROMPT}
${TEMPLATE_CUSTOMIZATION_PROMPT}
${SUPABASE_ENVIRONMENT_PROMPT}

PROVISIONED ENVIRONMENT VARIABLES (Sandbox):
The following variables are available in \`.env.local\` and \`process.env\`: ${(p.provisionedEnvKeys || []).join(', ')}

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
${constraintBlock}
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
- Never start an item whose \`blocked_by\` array is non-empty. A blocker affects only its source item and dependency descendants; continue with another pending item that has no blockers.
- If work cannot proceed, call \`requirement_backlog action='report_blocker'\` with a typed category, concrete reason, and resolution_actor. Set resolution_actor='user' only for a specific credential, irreversible approval, or material product decision that an agent cannot make.
- Use \`requirement_backlog action='resolve_blocker'\` after the blocker is actually resolved. Never mark the whole requirement blocked while an independent backlog item remains runnable.
- If the current phase has no pending items but the requirement is not done, advance the phase via the flow (the backlog tool enforces this).

HARD RULE ANTI-REWORK:
- Plans that touch done items, or files outside the current item's \`touches[]\` contract, are rejected by the anti-rework guard.
- Never reopen \`done\` or \`needs_review\` items with model-facing tools. A new external user action owns review recovery. If genuinely new scope is requested, create a separate remediation item instead of mutating terminal history.

YOUR ROLE: COORDINATOR — You PLAN and DELEGATE. You do NOT write code yourself.

ENVIRONMENT:
- Use sandbox tools to INVESTIGATE (sandbox_run_command, sandbox_read_file, sandbox_list_files) — max 3 calls per cycle.
- Complete general repository investigation with those coordinator calls BEFORE creating a build-phase plan. Do not delegate an open-ended "investigate current implementation/errors" step to the executor.
- ${ORCHESTRATOR_SKILL_LOOKUP_HINT}
- Use \`requirement_backlog\` (action=list / get / upsert / start / downgrade / log_assumption / report_blocker / resolve_blocker / non-terminal set_status) as the primary state tool. list is a compact, paginated open queue; get with item_id returns full acceptance, constraints, evidence and history. Do not call action=complete, action=mark_needs_review, or set_status to done/rejected/needs_review; terminal transitions belong to the runner.
- Use \`requirement_status\` to report progress. ALWAYS use requirement_id="${p.reqId}".
- Use \`instance_plan\` to create execution plans. ALWAYS use instance_id="${p.instanceId}". Once a requirement plan is active, continue it; do not create a replacement plan. Finish executor work with action=execute_step so the runner can gate it.
- ${TOOL_LOOKUP_HINT}
- Each plan step should have a \`skill\` (preferred) or \`role\` for injection, and a \`metadata.backlog_item_id\` pointing to the single item it delivers.
- Every step MUST define a non-empty \`expected_output\`, \`success_criteria\`, and \`validation_rules\`. These fields are the executor's stop contract, not optional documentation.
- Any step whose completion depends on automated tests MUST also set \`test_command\` to the exact bounded command that the deterministic gate must execute. Mentioning a command only in \`instructions\`, \`success_criteria\`, or \`validation_rules\` is not sufficient.
- A step with \`type='research'\` MUST use \`role='investigate'\` and \`skill='makinari-fase-investigacion'\`. In a build-phase backlog item, standalone research is forbidden unless \`metadata.blocking_unknown\` names one concrete unknown that prevents implementation. Otherwise fold the necessary file inspection into the implementation step.
- Historical failures are context, not assumed current failures. Research and validation steps must explicitly allow "not reproducible with current evidence" as a terminal result after their declared checks pass.
- NEVER run git commit or git push as coordinator — executors follow platform rules; the workflow checkpoints to origin after each plan step.
- ${ORCHESTRATOR_STEP_ORIGIN_RULE}

WORKFLOW (follow IN ORDER):
1. FIRST tool call: \`requirement_backlog\` with \`action='list'\`, requirement_id="${p.reqId}" — inspect the current phase and open queue. Follow pagination.next_offset when has_more is true. Reuse summary.active_item_ids before choosing pending work. Use list_status='all' to inspect terminal items when checking for duplicates. Call action='get' with the chosen item_id before planning to read its full acceptance, constraints, evidence and blockers.
2. Only if summary.total_items is 0, the backlog is empty and this is the FIRST cycle. An empty filtered page does not mean the backlog is empty. You MUST do two things:
   a) Rewrite \`requirement.spec.md\` using \`sandbox_write_file\` to replace all "_To be refined..._" placeholders with a concrete architecture, exact navigation flows, data models, and acceptance criteria.
   b) Derive a COMPREHENSIVE list of items (as many as needed to fully cover the scope, typically 5-15) DIRECTLY FROM your newly fleshed-out contract and \`action='upsert'\` them. These items form the Backlog. Remember the hierarchy: A Requirement has many Backlog Items, and each Backlog Item will later be broken down into an \`instance_plan\` (a sequence of execution steps). Each item needs \`title\`, \`kind\`, \`phase_id\`, \`acceptance[]\`, \`acceptance_contract\`, and \`tier\` ('core' or 'ornamental'). Set \`acceptance_contract.schema_version=2\` and \`source='declared'\`; give every acceptance entry a matching criterion id and typed \`all_of\` claims. CRITICAL: You MUST eliminate ambiguity. For UI features, explicitly declare exact routes when they are known. When a behavior has no known route, declare a \`semantic_assertion\` and add \`discovery.query\` plus a concise \`discovery.hypothetical_code\` specimen. That specimen is retrieval input only: never invent a route from it. For backend, declare exact API methods, paths, expected statuses, authentication expectations, and data schema. CRITICAL: For specific app or site deliverables, you MUST explicitly include a backlog item to deeply restructure the home page to reflect the requested specific domain, removing any generic template content.
3. Pick the single next unblocked item (WIP=1). It must have \`blocked_by=[]\` or no \`blocked_by\` field and all \`depends_on\` items done. Call \`action='start'\` to mark it in_progress.
4. If the active criterion has a \`discovery\` specimen, call \`sandbox_code_search action='vector_search'\` with the query plus hypothetical code, then confirm promising files with \`find_symbol\` or source reads. Cosine similarity discovers candidates only: derive routes from confirmed Next.js page/route files and never turn a vector hit directly into a required validation target.
5. Create the plan: \`instance_plan\` with \`action='create'\`. ${breakdownInstruction} Do NOT just copy the item title into a single step. Do NOT create generic steps like "Step 1" with instructions "Execute step 1". Every step MUST have a descriptive \`title\`, specific \`instructions\`, a clear objective, non-empty \`expected_output\`, \`success_criteria\`, and \`validation_rules\`. Every step MUST set \`skill\` and \`metadata.backlog_item_id=<id>\`. Steps that require automated tests MUST set the exact \`test_command\`. The plan MUST contain implementation or verification work for every acceptance entry; a local test run does not satisfy an acceptance entry that explicitly requires CI on push or pull request. CRITICAL: Maximize the use of the plan schema. For the overall plan, you MUST provide \`expected_output\`, \`success_criteria\` (array of specific files created/modified), and \`validation_rules\` (array of specific test files passed) to enforce strict quality control. For frontend steps, you MUST explicitly describe the UI layout, components to use (e.g., Shadcn UI Cards, Dialogs, Tables), and responsive behavior in the step instructions. Do not leave UI execution up to interpretation. If this is a new branch, Step 1 MUST be \`makinari-obj-template-selection\`. Do NOT add a step to notify the team in your plan.
6. Check if the INSTRUCTIONS ask for any new changes or features that are NOT covered by the existing backlog items. If there are new unhandled requests, you MUST create new backlog items to cover them using \`requirement_backlog action='upsert'\`.
7. ONLY if ALL items in the backlog (including ornamental) are completely done AND there are no new requests in the instructions: to finalize the work, simply call \`requirement_status\` with \`stage='on-review'\` and \`message='Project complete'\`. DO NOT create an instance plan or a new backlog item to close the project. Just set the status to on-review and return a plain text response. CRITICAL: If ANY items (core or ornamental) remain in the 'pending' or 'in_progress' state, YOU MUST NOT call \`requirement_status\` to close the project. Instead, you MUST create an \`instance_plan\` to process the pending items.

CRITICAL EXECUTION RULES:
1. ALWAYS THINK OUT LOUD: You MUST explain your reasoning and plan inside the \`thought_process\` parameter of every tool call.
2. MAXIMIZE PARALLELISM: If you need to read multiple files, list multiple directories, or run independent commands, you MUST call multiple tools in parallel in a single response. Do not do things sequentially if they can be batched.
3. AVOID LOOPS: If you find yourself reading the same files or running the same commands without making progress, STOP. Re-evaluate your approach and use a different tool (like sandbox_code_search instead of reading files blindly).

${closureBlock}

HARD RULE ACCEPTANCE (Phase 10):
- Every \`tier='core'\` item MUST provide a schema-version-2 declared acceptance contract with one or more typed claims per criterion. Free-form acceptance text is for humans; the declared contract is the executable source of truth. Legacy text-only items remain supported but their inferred routes are advisory and cannot hard-fail the product.
- CRITICAL: For transactional features (forms, bookings, creation, updates), acceptance criteria MUST explicitly require verifying the database state or backend API response (e.g., "POST /api/bookings inserts a record in the database and returns 201"). Do NOT accept purely visual criteria like "returns 200 and renders a form" for transactional operations.
- CRITICAL: For authentication and user management features (login, signup, sessions, roles), acceptance criteria MUST explicitly require verifying the real authentication flow via OTP (One-Time Password). NEVER use traditional passwords. (e.g., "POST /api/auth/login sends OTP, POST /api/auth/verify verifies OTP and sets session"). Do NOT accept purely visual criteria like "renders a login form".
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
  const completedIds = new Set(
    backlog.items
      .filter((item) => item.status === 'done')
      .map((item) => item.id),
  );
  const pending = backlog.items
    .filter(
      (item) =>
        item.phase_id === phaseId &&
        isBacklogItemRunnable(item, completedIds),
    )
    .slice(0, 3);
  const blocked = backlog.items
    .filter((item) => item.blocked_by?.length)
    .slice(0, 3);
  const done = backlog.items.filter((i) => i.status === 'done').length;
  const total = backlog.items.length;

  return `
BACKLOG:
  CURRENT PHASE: ${phaseId} — ${phaseTitle}  (${done}/${total} done, ratio ${backlog.completion_ratio})
  ${inProgress ? `IN_PROGRESS: ${renderItem(inProgress)}` : 'IN_PROGRESS: (none — pick one from the queue)'}
  NEXT UP (max 3):
${pending.length ? pending.map((i) => `    - ${renderItem(i)}`).join('\n') : '    (none in this phase — advance the phase)'}
  BLOCKED (max 3; do not start, continue independent work):
${blocked.length ? blocked.map((i) => `    - ${renderItem(i)}`).join('\n') : '    (none)'}
`;
}

function renderItem(i: BacklogItem): string {
  const accept = (i.acceptance || []).slice(0, 2).map((a) => `"${a.slice(0, 80)}"`).join(' + ');
  const tier = i.tier ?? 'core';
  const contractVersion = i.acceptance_contract?.schema_version;
  const discovery = i.acceptance_contract?.schema_version === 2
    ? i.acceptance_contract.criteria
        .map((criterion) => criterion.discovery?.query)
        .filter((query): query is string => !!query)
        .slice(0, 2)
        .join(' | ')
    : '';
  const blockers = (i.blocked_by || [])
    .map((blocker) =>
      `${blocker.blocker_id}:${blocker.resolution_actor}`)
    .join(',');
  return `[${i.id.slice(0, 8)}] kind=${i.kind} tier=${tier} scope=${i.scope_level} attempts=${i.attempts}${contractVersion ? ` contract=v${contractVersion}` : ''}${blockers ? ` blocked_by=${blockers}` : ''} — ${i.title}${accept ? ` | acceptance: ${accept}` : ''}${discovery ? ` | retrieval: ${discovery}` : ''}`;
}

/** Back-compat alias kept until all workflows adopt the new name. */
export const buildOrchestratorPrompt = buildCoordinatorPromptForFlow;
