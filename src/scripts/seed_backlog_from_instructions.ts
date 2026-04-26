/**
 * Seed `requirements.backlog` for legacy in-progress requirements
 * that predate the Flow + Backlog refactor (Phase 2).
 *
 * Idempotent:
 *   - Skips requirements that already carry `backlog` with items.
 *   - Parses `## 9. Execution Plan` checkbox list from `requirements.instructions`
 *     (preferred) and converts each `- [ ] foo` / `- [x] foo` line into a
 *     `BacklogItem`.
 *   - Heuristic fallback: derive items from lines matching patterns like
 *     "Build <X>", "Implement <X>", "Create <X>".
 *
 * Usage:
 *   $ pnpm tsx src/scripts/seed_backlog_from_instructions.ts
 *
 * Flags:
 *   --dry-run      Print what would change without persisting.
 *   --limit N      Process at most N requirements (useful for canary).
 *   --req <id>     Seed a single requirement by id.
 */

import { supabaseAdmin } from '@/lib/database/supabase-client';
import { classifyRequirementType, getFlow } from '@/lib/services/requirement-flows';
import { upsertBacklogItem } from '@/lib/services/requirement-backlog';
import type { BacklogItemKind, BacklogItemTier } from '@/lib/services/requirement-backlog-types';

interface Args {
  dryRun: boolean;
  limit?: number;
  reqId?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--limit') args.limit = Number(argv[++i] || '0') || undefined;
    else if (a === '--req') args.reqId = argv[++i];
  }
  return args;
}

interface RawItem {
  title: string;
  done: boolean;
  tier: BacklogItemTier;
}

function parseChecklist(body: string, tier: BacklogItemTier): RawItem[] {
  const items: RawItem[] = [];
  for (const raw of body.split('\n')) {
    const m = raw.match(/^\s*-\s+\[( |x|X)\]\s+(.+?)\s*$/);
    if (!m) continue;
    const done = m[1].toLowerCase() === 'x';
    const title = m[2].trim();
    if (title) items.push({ title, done, tier });
  }
  return items;
}

/**
 * Phase 10: prefer explicit "Functional / Core" vs "Ornamental / Nice to have"
 * sections when they exist. That way the seed script respects the author's
 * intent — only items parsed from a Functional section get tier='core'.
 */
function parseTieredSections(instructions: string): RawItem[] {
  const funcRe = /^##\s+(Functional|Funcional|Core)\s*(\(.*\))?\s*$/mi;
  const ornRe = /^##\s+(Ornamental|Nice[- ]?to[- ]?have|Polish)\s*(\(.*\))?\s*$/mi;
  const funcBody = extractSection(instructions, funcRe);
  const ornBody = extractSection(instructions, ornRe);
  const items: RawItem[] = [];
  if (funcBody) items.push(...parseChecklist(funcBody, 'core'));
  if (ornBody) items.push(...parseChecklist(ornBody, 'ornamental'));
  return items;
}

function parseExecutionPlan(instructions: string): RawItem[] {
  const plan = extractSection(instructions, /^##\s+9\.\s*Execution\s*Plan/mi);
  if (!plan) return [];
  // Legacy "## 9. Execution Plan" checklists don't distinguish core vs
  // ornamental. To stay strict-by-default we treat them all as `core` and
  // let the Judge / Critic escalate items that clearly don't belong.
  return parseChecklist(plan, 'core');
}

function extractSection(markdown: string, headingRe: RegExp): string | null {
  const lines = markdown.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingRe.test(lines[i])) { start = i; break; }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start + 1, end).join('\n');
}

function heuristicItems(instructions: string): RawItem[] {
  const items: RawItem[] = [];
  const seen = new Set<string>();
  for (const line of instructions.split('\n')) {
    const m = line.match(/^\s*(?:-|\d+\.)\s+(?:Build|Implement|Create|Add|Design)\s+(.{5,120})\.?$/i);
    if (!m) continue;
    const title = m[1].trim();
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // Heuristic: lines that only mention documentation / landing / overview
    // get demoted to ornamental so the Judge doesn't block closure on them.
    const ornamental = /\b(landing|overview|vision|visi[oó]n|README|map|mapa|arquitectura|mock|mockup|placeholder)\b/i.test(title);
    items.push({ title, done: false, tier: ornamental ? 'ornamental' : 'core' });
  }
  return items.slice(0, 10);
}

function inferKind(title: string, flowKinds: BacklogItemKind[]): BacklogItemKind {
  const t = title.toLowerCase();
  if (flowKinds.includes('page') && /page|route|screen/.test(t)) return 'page';
  if (flowKinds.includes('component') && /component|card|button|modal/.test(t)) return 'component';
  if (flowKinds.includes('crud') && /(crud|create|edit|delete|update).*(record|row|entity)/.test(t)) return 'crud';
  if (flowKinds.includes('api') && /api|endpoint|route\.ts/.test(t)) return 'api';
  if (flowKinds.includes('auth') && /auth|login|sign[- ]?in|signup/.test(t)) return 'auth';
  if (flowKinds.includes('integration') && /integr|webhook|email|sms|whats|payment/.test(t)) return 'integration';
  if (flowKinds.includes('section') && /section|chapter|page/.test(t)) return 'section';
  if (flowKinds.includes('slide') && /slide|deck/.test(t)) return 'slide';
  if (flowKinds.includes('clause') && /clause/.test(t)) return 'clause';
  return flowKinds[0];
}

async function seedOne(reqId: string, dryRun: boolean): Promise<boolean> {
  const { data: req } = await supabaseAdmin
    .from('requirements')
    .select('id, type, instructions, backlog, status')
    .eq('id', reqId)
    .maybeSingle();
  if (!req) {
    console.warn(`[seed] requirement ${reqId} not found`);
    return false;
  }
  const backlog = (req.backlog as Record<string, any> | null) ?? null;
  if (backlog?.items && Array.isArray(backlog.items) && backlog.items.length > 0) {
    console.log(`[seed] skip ${reqId} — backlog already present (${backlog.items.length} items)`);
    return false;
  }
  const kind = classifyRequirementType(req.type);
  const flow = getFlow(kind);
  const phaseId = flow.phases[0]?.id ?? 'default';
  const flowKinds = flow.backlog_kinds;

  const instructions = typeof req.instructions === 'string' ? req.instructions : '';
  let raw = parseTieredSections(instructions);
  let source: 'tiered_sections' | 'execution_plan' | 'heuristic' = 'tiered_sections';
  if (raw.length === 0) {
    raw = parseExecutionPlan(instructions);
    source = 'execution_plan';
  }
  if (raw.length === 0) {
    raw = heuristicItems(instructions);
    source = 'heuristic';
  }
  if (raw.length === 0) {
    console.warn(`[seed] ${reqId} — no items derivable (source=${source})`);
    return false;
  }

  const coreCount = raw.filter((r) => r.tier === 'core').length;
  console.log(
    `[seed] ${reqId} kind=${kind} source=${source} items=${raw.length} core=${coreCount} ornamental=${raw.length - coreCount}${dryRun ? ' (dry-run)' : ''}`,
  );
  if (dryRun) {
    for (const r of raw.slice(0, 8)) console.log(`    - ${r.done ? '[x]' : '[ ]'} [${r.tier}] ${r.title}`);
    if (raw.length > 8) console.log(`    ... ${raw.length - 8} more`);
    return true;
  }

  for (const r of raw) {
    const itemKind = inferKind(r.title, flowKinds);
    // Build a slightly more anchored acceptance so the Judge tokenizer has
    // something to match. The orchestrator LLM is expected to refine these
    // on its next pass via `requirement_backlog action='upsert'`.
    const acceptance = r.tier === 'core'
      ? buildCoreAcceptance(r.title, itemKind)
      : [`Delivers "${r.title}" as described in the instructions`];
    await upsertBacklogItem({
      requirementId: reqId,
      item: {
        title: r.title,
        kind: itemKind,
        phase_id: phaseId,
        acceptance,
        scope_level: 'full',
        tier: r.tier,
        status: r.done ? 'done' : 'pending',
      },
    });
  }
  return true;
}

function buildCoreAcceptance(title: string, kind: BacklogItemKind): string[] {
  const t = title.toLowerCase();
  const out: string[] = [];
  switch (kind) {
    case 'page':
      out.push(`Renders page at /${slugify(title)} and returns 200`);
      break;
    case 'crud':
      out.push(`GET /api/${slugify(title)} returns 200 with a list`);
      out.push(`POST /api/${slugify(title)} creates a record and returns 201`);
      break;
    case 'api':
      out.push(`GET /api/${slugify(title)} returns 200`);
      break;
    case 'auth':
      out.push(`/login accepts credentials and redirects on success`);
      break;
    case 'integration':
      out.push(`Integration endpoint responds 200 on a live probe`);
      break;
    default:
      out.push(`Delivers "${title}" with an observable, testable outcome`);
  }
  // Always keep the original title as an acceptance hint so downstream skills
  // can refine it without losing the author's intent.
  out.push(`Matches original request: ${title}`);
  return out;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[áàä]/g, 'a').replace(/[éèë]/g, 'e').replace(/[íìï]/g, 'i')
    .replace(/[óòö]/g, 'o').replace(/[úùü]/g, 'u').replace(/[ñ]/g, 'n')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'feature';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.reqId) {
    await seedOne(args.reqId, args.dryRun);
    return;
  }
  const { data: list } = await supabaseAdmin
    .from('requirements')
    .select('id')
    .in('status', ['in-progress', 'backlog', 'pending'])
    .order('updated_at', { ascending: false })
    .limit(args.limit ?? 500);
  const ids = (list ?? []).map((r) => r.id as string);
  console.log(`[seed] scanning ${ids.length} requirement(s)`);
  let seeded = 0;
  for (const id of ids) {
    try {
      const ok = await seedOne(id, args.dryRun);
      if (ok) seeded++;
    } catch (e: unknown) {
      console.error(`[seed] ${id} failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(`[seed] done — seeded ${seeded}/${ids.length}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
