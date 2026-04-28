'use step';
/**
 * Durable step: bootstrap `requirement.spec.md` from the DB before the
 * coordinator runs.
 *
 * Split out of `cron-steps.ts` to keep that file under the 500-line budget
 * and to make the bootstrap concern (a) unit-testable and (b) reusable by
 * other flows (docs, slides, contract, task) which all share the same
 * orchestrator expectation that a spec file is present on the branch.
 *
 * The step is 'use step' so it runs in the regular Next.js runtime (same
 * rules as the other durable steps): safe to import `@vercel/sandbox`,
 * `supabase-client`, etc.
 */

import { Sandbox } from '@vercel/sandbox';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { SandboxService } from '@/lib/services/sandbox-service';
import {
  CronInfraEvent,
  logCronInfrastructureEvent,
  type CronAuditContext,
} from '@/lib/services/cron-audit-log';

export interface BootstrapRequirementSpecResult {
  wrote: boolean;
  reason: string;
  effectiveSandboxId: string;
}

/**
 * Writes a minimal `requirement.spec.md` to the sandbox when the file does
 * not yet exist on the branch.
 *
 * Rationale: the orchestrator prompt tells the coordinator to derive backlog
 * items from `requirement.spec.md`. On a fresh branch that file does not
 * exist (it is only produced by the first commit), so the coordinator keeps
 * calling `sandbox_read_file` (which fails), never reaches
 * `instance_plan action='create'` and the cron picks up the same requirement
 * forever.
 *
 * Bootstrapping the spec from the canonical DB row (title + instructions)
 * breaks that chicken-and-egg: the file is present from turn 1, and the
 * first commit carries it to origin so subsequent cycles read the same
 * ground truth. Idempotent — never overwrites an existing spec.
 */
export async function bootstrapRequirementSpecStep(params: {
  sandboxId: string;
  requirementId: string;
  audit?: CronAuditContext;
}): Promise<BootstrapRequirementSpecResult> {
  'use step';
  const { sandboxId, requirementId, audit } = params;
  const effectiveSandboxId = sandboxId;

  let sandbox: Sandbox;
  try {
    sandbox = await Sandbox.get({ sandboxId });
  } catch (e: unknown) {
    console.warn(
      `[BootstrapSpec] Sandbox ${sandboxId} unavailable (${e instanceof Error ? e.message : e}); skipping.`,
    );
    return { wrote: false, reason: 'sandbox unavailable', effectiveSandboxId };
  }

  const cwd = SandboxService.WORK_DIR;
  const specPath = `${cwd}/requirement.spec.md`;

  // Idempotent guard — respect whatever the branch already has.
  const existsRes = await sandbox.runCommand({
    cmd: 'sh',
    args: ['-c', `[ -f "${specPath}" ] && echo EXISTS || echo MISSING`],
  });
  const existsOut = (await existsRes.stdout()).toString().trim();
  if (existsOut === 'EXISTS') {
    return { wrote: false, reason: 'spec already present', effectiveSandboxId };
  }

  const { data: req, error } = await supabaseAdmin
    .from('requirements')
    .select('id, title, type, instructions')
    .eq('id', requirementId)
    .maybeSingle();

  if (error || !req) {
    console.warn(
      `[BootstrapSpec] Could not load requirement ${requirementId} from DB (${error?.message ?? 'not found'}); skipping.`,
    );
    return { wrote: false, reason: 'requirement row missing', effectiveSandboxId };
  }

  const title = (req.title ?? '').toString().trim() || 'Untitled requirement';
  const kind = (req.type ?? '').toString().trim() || 'app';
  const instructions =
    (req.instructions ?? '').toString().trim() ||
    '(no instructions provided — derive scope from title)';

  const body = renderBootstrapSpec({
    title,
    kind,
    requirementId,
    instructions,
  });

  const b64 = Buffer.from(body, 'utf8').toString('base64');
  try {
    await sandbox.runCommand({
      cmd: 'sh',
      args: ['-c', `echo '${b64}' | base64 -d > "${specPath}"`],
    });
  } catch (e: unknown) {
    console.warn(
      `[BootstrapSpec] Write failed for ${specPath}: ${e instanceof Error ? e.message : e}`,
    );
    return { wrote: false, reason: 'write failed', effectiveSandboxId };
  }

  console.log(
    `[BootstrapSpec] Wrote initial requirement.spec.md (${body.length} chars) for req ${requirementId}`,
  );

  // Piggyback on the existing git-workspace-ready channel so the audit log
  // shows the bootstrap near the other infra setup events for the same
  // sandbox. Keep it advisory (level=info) — failure here never blocks the
  // workflow, the spec is best-effort.
  await logCronInfrastructureEvent(audit, {
    event: CronInfraEvent.GIT_WORKSPACE_READY,
    level: 'info',
    message: `Bootstrapped requirement.spec.md from DB (${body.length} chars)`,
    details: {
      sandboxId: effectiveSandboxId,
      requirementId,
      instructionsChars: instructions.length,
      bootstrapped: true,
    },
  });

  return { wrote: true, reason: 'bootstrapped', effectiveSandboxId };
}

function renderBootstrapSpec(params: {
  title: string;
  kind: string;
  requirementId: string;
  instructions: string;
}): string {
  const { title, kind, requirementId, instructions } = params;
  const ts = new Date().toISOString();
  return [
    `# ${title}`,
    '',
    '> Immutable contract for this requirement. Agents append to `## Revisions` when fields change; they do NOT rewrite the body. The live backlog lives in `feature_list.json` / `requirement_backlog`.',
    '',
    `- requirement_id: ${requirementId}`,
    `- kind: ${kind}`,
    `- bootstrapped_at: ${ts}`,
    '',
    '## 1. Overview',
    instructions,
    '',
    '## 2. Audience',
    '_To be refined by the coordinator in the FIRST cycle. Define exact user roles and their permissions._',
    '',
    '## 3. Goals',
    '_To be refined by the coordinator in the FIRST cycle. Keep to 3–5 measurable goals._',
    '',
    '## 4. Non-goals',
    '_To be refined by the coordinator in the FIRST cycle. List explicitly excluded scope to prevent drift._',
    '',
    '## 5. Guidelines',
    '- Next.js App Router under `src/app/`. No nested project directories.',
    '- Keep files under 500 lines; refactor in place when they grow past that.',
    '- Prefer functional, typed code. No mocked responses — real DB / API calls.',
    '',
    '## 6. Contracts & Navigation',
    '_To be refined by the coordinator in the FIRST cycle. Define the exact Route map, navigation flow, data models, and API contracts to eliminate ambiguity._',
    '',
    '## 7. Acceptance',
    '_To be refined by the coordinator in the FIRST cycle. Concrete, observable acceptance criteria — anchored in routes, status codes, or verbs._',
    '',
    '## 8. Base hint',
    '_Optional scaffolding hint (template, standard library) chosen for this requirement._',
    '',
    '## Revisions',
    `- ${ts} — bootstrap: seeded from \`requirements.instructions\` at the first cron tick.`,
    '',
  ].join('\n');
}
