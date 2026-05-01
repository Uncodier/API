/**
 * Prompt fragments only (no sandbox / assistant imports) — safe for workflow bundles.
 */

export const MAX_PUSH_RECOVERY_TURNS = 3;

export const ORCHESTRATOR_STEP_ORIGIN_RULE =
  'Every plan step must produce real repo changes that end up on origin: cron runs npm run build, then commit+push, then REACTIVE recovery if push fails — tell executors the step is not done until the platform has verified origin (they may need to push manually only in REACTIVE mode).';

/** Use in orchestrator system prompts (sandbox cron). */
export const ORCHESTRATOR_SKILL_LOOKUP_HINT =
  'SKILLS: Use the skill_lookup tool early — action=search with keywords from the requirement title, instructions, and domain; action=list to browse. Align plan steps (roles, deliverables) with relevant playbooks before delegating.';

/**
 * Shared hint about `tool_lookup` for orchestrator + executor prompts.
 *
 * Only the always-on tools (sandbox_*, skill_lookup, instance_plan,
 * requirement_status, requirements, tool_lookup itself) are loaded into the
 * model's schema window. Everything else (media, messaging, CRM, social,
 * content, infra, research) is discoverable and invocable via `tool_lookup`.
 */
export const TOOL_LOOKUP_HINT = [
  'TOOLS (beyond sandbox_*, instance_plan, requirement_status, requirements, skill_lookup):',
  '- Use `tool_lookup({ action: "list" })` to see every routed tool grouped by category (media, messaging, crm, social, content, infra, research).',
  '- Use `tool_lookup({ action: "describe", name: "<tool>" })` to get the exact parameters schema + expected_use for a specific tool before calling it.',
  '- Use `tool_lookup({ action: "call", name: "<tool>", args: "{ ... }" })` to execute it (args must be a JSON string). If args are invalid the error includes the parameters schema so you can auto-correct and retry.',
  '- Examples: generate_image, sendEmail, leads, sales, socialMediaPublish, content, webSearch — ALL live behind tool_lookup. The router is the only way to reach them.',
].join('\n');

/** Enforced in code: git + clone root must stay at /vercel/sandbox (never move .git or the repo under app/). */
export const SANDBOX_REPO_ROOT_INVARIANT = [
  'SANDBOX GIT ROOT (mandatory): The Git clone and package.json live at WORKSPACE ROOT /vercel/sandbox — never under /vercel/sandbox/app.',
  'Do NOT move, copy, or symlink .git into app/. Do NOT relocate the repository so that git top-level becomes /vercel/sandbox/app.',
  'Next.js App Router routes belong in src/app/ (e.g. src/app/page.tsx), not in a root folder named app/ for the whole repo.',
  'Do NOT add a fake minimal package.json at /vercel/sandbox only to pass build while the real project sits under app/ — that breaks push, preview, and automation.',
  'Vercel runs npm ci: commit a valid package-lock.json from the repo root and keep "next" in dependencies (apps repo). Stub manifests fail on Vercel even if local npm run build is wired to no-op.',
  'If you broke the layout, you cannot fix it with symlinks; the next workflow run will reprovision the VM from origin.',
].join(' ');

export function getStepCheckpointPromptFragment(requirementId: string, instanceId: string): string {
  const ridHint = requirementId
    ? `requirement_id="${requirementId}"`
    : 'requirement_id (from context when available)';
  const iidHint = instanceId
    ? `instance_id="${instanceId}"`
    : 'instance_id (from context when available)';
  return `
${SANDBOX_REPO_ROOT_INVARIANT}

CHECKPOINTS & RECOVERY (read this):
- MANDATORY TOOL — sandbox_push_checkpoint: If you changed any files or created commits locally, you MUST call sandbox_push_checkpoint at least once before you stop working on this step (typically after npm run build succeeds). Use title_hint = this step's title. If the tool reports nothing to push because the tree is already synced with origin, that counts — but you must still have invoked it. Never skip it to "save time". skill_lookup and SKILL.md playbooks do NOT replace this — checkpoints are separate.
- CRITICAL: Before calling sandbox_push_checkpoint on a new Next.js project, you MUST verify that node_modules and .next are NOT in the git cache. If they are, run \`git rm -r --cached node_modules .next\` first.
- You must NOT consider the step finished until your repo changes are on the remote feature branch (origin). Automated cron workflows verify npm run build and commit+push before marking the step complete; if push fails, you get a REACTIVE TASK and must commit/push yourself until origin is updated.
- Until origin is verified, the step does not complete. Do not use raw "git commit" or "git push" via sandbox_run_command during normal execution — EXCEPT: (1) call sandbox_push_checkpoint as above; (2) when you receive "REACTIVE TASK" / "PUSH RECOVERY", fix the repo and then use sandbox_push_checkpoint or follow the recovery git steps.
- When calling tools that need IDs, use ${ridHint} and ${iidHint}.
- If the build breaks or you need to rewind the whole tree: sandbox_restore_checkpoint (action=list) then action=restore with a commit_sha; for single files use git restore via sandbox_run_command as needed.
- Be efficient — the sandbox has a limited lifetime.

SKILLS (on demand — use every step):
- skill_lookup is for procedures; sandbox_push_checkpoint is for persisting work to origin. Use both when applicable.
- Before substantial coding, call skill_lookup with action=search using keywords from this step's objective, title, instructions, and tech stack (e.g. "next.js landing seo", "automation test mode").
- Use action=get with skill_name from the search results (or action=list if unsure) to load the full SKILL.md and follow it; it complements any SKILL block injected above.
- If search returns few matches, broaden keywords or repeat search with synonyms.`;
}
