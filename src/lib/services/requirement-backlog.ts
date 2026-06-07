/**
 * Backlog service — reads/writes `requirements.backlog` with the
 * WIP=1 rule enforced. The backlog is agnostic to requirement kind; phase ids
 * come from the flow registry (`requirement-flows.ts`).
 *
 * This module owns the public CRUD surface (list / upsert / start / complete
 * / status mutations). Lifecycle helpers (watchdog, attempts bump, instance
 * resolver) live in `requirement-backlog-watchdog.ts` and are re-exported
 * here for back-compat. Storage primitives (DB load/write, ratio, phase
 * reconcile) live in `requirement-backlog-store.ts`.
 */

import {
  classifyRequirementType,
  getFlow,
  advancePhaseIfReadyInMemory,
  type RequirementKind,
} from './requirement-flows';
import {
  type BacklogItem,
  type BacklogItemKind,
  type BacklogItemScope,
  type BacklogItemStatus,
  type BacklogItemTier,
  type RequirementBacklog,
} from './requirement-backlog-types';
import {
  computeRatio,
  loadRequirement,
  reconcilePhaseForItem,
  toBacklog,
  writeBacklog,
} from './requirement-backlog-store';
import { validateAcceptance } from './requirement-acceptance';
import { cancelPlanStepsForBacklogItem } from '@/lib/helpers/plan-lifecycle';

export type { BacklogItem, BacklogItemStatus, BacklogItemKind, BacklogItemScope, BacklogItemTier, RequirementBacklog };

// Lifecycle helpers (watchdog + attempts + instance resolver) are re-exported
// so existing callers keep their import path stable after the refactor.
export {
  bumpItemAttempts,
  ensureInProgressItem,
  escalateStaleInProgressItems,
  resolveBacklogContextForInstance,
} from './requirement-backlog-watchdog';

export function isItemTerminal(status: string): boolean {
  return status === 'done' || status === 'needs_review';
}

export function gatingItems(items: BacklogItem[]): BacklogItem[] {
  const core = items.filter((i) => (i.tier ?? 'core') === 'core');
  return core.length > 0 ? core : items;
}

export function isBacklogComplete(items: BacklogItem[]): boolean {
  const gating = gatingItems(items);
  return gating.length > 0 && gating.every((i) => isItemTerminal(i.status));
}

export function outstandingGatingItems(items: BacklogItem[]): BacklogItem[] {
  return gatingItems(items).filter((i) => !isItemTerminal(i.status) && i.status !== 'rejected');
}

export function hasOutstandingWork(items: BacklogItem[]): boolean {
  return items.some((i) => !isItemTerminal(i.status) && i.status !== 'rejected');
}

/**
 * True when every `tier='core'` item is in a terminal state (`done` or
 * `needs_review`). Consumers (flow engine, close-requirement gates) should
 * call this instead of checking `completion_ratio === 1`.
 * @deprecated Use `isBacklogComplete(items)` instead.
 */
export function coreItemsAllDone(items: BacklogItem[]): boolean {
  return isBacklogComplete(items);
}

/**
 * @deprecated Use `outstandingGatingItems(items)` instead.
 */
export function pendingCoreItems(items: BacklogItem[]): BacklogItem[] {
  return outstandingGatingItems(items);
}

const TERMINAL_REQUIREMENT_STAGES = new Set(['done', 'completed', 'cancelled', 'failed']);

export async function isRequirementReopened(requirementId: string): Promise<boolean> {
  const { supabaseAdmin } = await import('@/lib/database/supabase-server');
  const { data } = await supabaseAdmin
    .from('requirement_status')
    .select('stage, created_at')
    .eq('requirement_id', requirementId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (!data || data.length === 0) return false;
  const latest = String(data[0].stage || '').toLowerCase();
  if (TERMINAL_REQUIREMENT_STAGES.has(latest)) return false;
  for (let i = 1; i < data.length; i++) {
    if (TERMINAL_REQUIREMENT_STAGES.has(String(data[i].stage || '').toLowerCase())) return true;
  }
  return false;
}

// Web Crypto UUID generator. Avoids importing the Node `crypto` module so this
// file can be safely bundled inside workflow functions (useworkflow.dev), which
// reject Node.js modules. `globalThis.crypto.randomUUID` is available in Node
// 19+ and in worker runtimes; we fall back to an RFC4122 v4 polyfill for
// environments where it's missing.
function generateUUID(): string {
  const g: any = (globalThis as any);
  if (g?.crypto?.randomUUID) return g.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (g?.crypto?.getRandomValues) {
    g.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function ensureItemDefaults(partial: Partial<BacklogItem> & { title: string; kind: BacklogItemKind; phase_id: string; acceptance: string[] }): BacklogItem {
  const now = new Date().toISOString();
  return {
    id: partial.id || generateUUID(),
    title: partial.title.trim(),
    kind: partial.kind,
    phase_id: partial.phase_id,
    acceptance: partial.acceptance,
    touches: partial.touches,
    status: (partial.status as BacklogItemStatus) || 'pending',
    attempts: typeof partial.attempts === 'number' ? partial.attempts : 0,
    assumptions: partial.assumptions,
    scope_level: partial.scope_level || 'full',
    tier: partial.tier ?? 'core',
    depends_on: partial.depends_on,
    evidence: partial.evidence,
    created_at: partial.created_at || now,
    updated_at: now,
  };
}

export async function listBacklog(requirementId: string): Promise<{ kind: RequirementKind; backlog: RequirementBacklog }> {
  const req = await loadRequirement(requirementId);
  if (!req) throw new Error(`Requirement ${requirementId} not found`);
  const kind = classifyRequirementType(req.type);
  const flow = getFlow(kind);
  return {
    kind,
    backlog: toBacklog(req.backlog, flow.phases[0]?.id || 'default'),
  };
}

export async function getBacklogItem(requirementId: string, itemId: string): Promise<{
  kind: RequirementKind;
  item: BacklogItem | null;
}> {
  const { kind, backlog } = await listBacklog(requirementId);
  const item = backlog.items.find((i) => i.id === itemId) ?? null;
  return { kind, item };
}

export async function upsertBacklogItem(params: {
  requirementId: string;
  item: Partial<BacklogItem> & { title: string; kind: BacklogItemKind; phase_id: string; acceptance: string[] };
}): Promise<BacklogItem> {
  const req = await loadRequirement(params.requirementId);
  if (!req) throw new Error(`Requirement ${params.requirementId} not found`);
  const flow = getFlow(classifyRequirementType(req.type));
  const backlog = toBacklog(req.backlog, flow.phases[0]?.id || 'default');

  const idx = params.item.id ? backlog.items.findIndex((i) => i.id === params.item.id) : -1;
  const next = ensureItemDefaults(
    idx >= 0 ? { ...backlog.items[idx], ...params.item } : params.item,
  );

  // Hard rule (matches Phase 10 Judge contract): a `tier=core` item must have
  // at least one *executable* acceptance entry — i.e. one that contains an
  // HTTP verb (GET/POST/...), a route anchor (`/foo`), a status-code anchor
  // (2xx/200/...) or an observable verb (returns/renders/inserts/...). If
  // every entry is narrative, the Judge will reject every cycle forever (no
  // amount of code can satisfy "Admin can configure max_capacity" because
  // there is no anchor to match in evidence). Refusing the upsert here makes
  // the orchestrator see a clear error in its tool result and forces it to
  // rewrite the acceptance with a real anchor, which is the only way out of
  // the loop. Existing items can still be updated as long as the post-merge
  // acceptance is executable.
  if ((next.tier ?? 'core') === 'core') {
    const v = validateAcceptance(next.acceptance);
    if (!v.has_any_executable) {
      throw new Error(
        `Backlog upsert rejected: tier=core item "${next.title}" has narrative-only acceptance. ` +
          `Add at least one executable anchor per entry — HTTP verb (GET/POST/...), route ` +
          `(/api/...), status code (2xx/200) or observable verb (returns, renders, inserts, ` +
          `creates, updates, deletes, redirects, persists). Example BEFORE: ` +
          `"Admin can configure max_capacity on studios". Example AFTER: ` +
          `"PATCH /api/studios/:id with { max_capacity: number } returns 200 and persists the value, ` +
          `and GET /api/studios returns it in the response payload". Or set tier=ornamental if this ` +
          `is polish-only and should not block requirement closure.`,
      );
    }
  }

  if (idx >= 0) {
    backlog.items[idx] = next;
  } else {
    backlog.items.push(next);
  }
  // When a new (or revived) item lands in a phase BEFORE the requirement's
  // current phase, the orchestrator would otherwise keep evaluating the
  // forward phase and never see the item — leaving it eternally
  // in_progress / pending. Reconciliation rewinds current_phase_id to the
  // earliest unfinished phase so the cron picks the item up next cycle.
  reconcilePhaseForItem(backlog, flow, next);
  backlog.completion_ratio = computeRatio(backlog.items);
  await writeBacklog(params.requirementId, backlog);
  return next;
}

export async function markInProgress(params: { requirementId: string; itemId: string }): Promise<BacklogItem> {
  const req = await loadRequirement(params.requirementId);
  if (!req) throw new Error(`Requirement ${params.requirementId} not found`);
  const flow = getFlow(classifyRequirementType(req.type));
  const backlog = toBacklog(req.backlog, flow.phases[0]?.id || 'default');

  const active = backlog.items.find((i) => i.status === 'in_progress');
  if (active && active.id !== params.itemId) {
    throw new Error(
      `WIP=1 violation: item ${active.id} ("${active.title}") is already in_progress. Complete or downgrade it before starting ${params.itemId}.`,
    );
  }

  const idx = backlog.items.findIndex((i) => i.id === params.itemId);
  if (idx < 0) throw new Error(`Item ${params.itemId} not found`);
  backlog.items[idx] = {
    ...backlog.items[idx],
    status: 'in_progress',
    attempts: (backlog.items[idx].attempts || 0) + 1,
    updated_at: new Date().toISOString(),
  };
  await writeBacklog(params.requirementId, backlog);
  return backlog.items[idx];
}

export async function setItemStatus(params: {
  requirementId: string;
  itemId: string;
  status: BacklogItemStatus;
  reason?: string;
}): Promise<BacklogItem> {
  const req = await loadRequirement(params.requirementId);
  if (!req) throw new Error(`Requirement ${params.requirementId} not found`);
  const flow = getFlow(classifyRequirementType(req.type));
  const backlog = toBacklog(req.backlog, flow.phases[0]?.id || 'default');

  const idx = backlog.items.findIndex((i) => i.id === params.itemId);
  if (idx < 0) throw new Error(`Item ${params.itemId} not found`);
  backlog.items[idx] = {
    ...backlog.items[idx],
    status: params.status,
    updated_at: new Date().toISOString(),
  };
  if (params.reason && params.status !== 'done') {
    const assumptions = backlog.items[idx].assumptions || [];
    backlog.items[idx].assumptions = [...assumptions, params.reason].slice(-20);
  }
  backlog.completion_ratio = computeRatio(backlog.items);

  // Piggy-back phase advance on the same write. When all items in the current
  // phase reach a terminal status (done / rejected / needs_review) and there
  // is a next phase defined for the flow, bump `current_phase_id` so the
  // orchestrator immediately starts pulling from the next phase on the next
  // turn. The engine helper is pure so this stays in a single DB roundtrip.
  const advance = advancePhaseIfReadyInMemory(backlog, flow);
  const toWrite = advance ? advance.nextBacklog : backlog;

  await writeBacklog(params.requirementId, toWrite);

  // Stop zombie plan loops: when the item leaves the actively-worked tier
  // toward a non-success terminal (needs_review / rejected), any pending or
  // in_progress plan steps still bound to it must be cancelled. Otherwise
  // `cron-execute-steps-phase` keeps running the same subgoals every tick.
  // (For `done` we leave the plan alone — its steps should already be
  // completing naturally as the work lands.)
  if (params.status === 'needs_review' || params.status === 'rejected') {
    try {
      const r = await cancelPlanStepsForBacklogItem({
        itemId: params.itemId,
        reason: `setItemStatus → ${params.status}: ${params.reason ?? 'no reason provided'}`.slice(0, 240),
      });
      if (r.stepsCancelled > 0) {
        console.warn(
          `[backlog] cancelled ${r.stepsCancelled} plan step(s) bound to item ${params.itemId} after status=${params.status} (plansTouched=${r.plansTouched}, plansCancelled=${r.plansCancelled})`,
        );
      }
    } catch (e) {
      console.warn(`[backlog] cancelPlanStepsForBacklogItem failed for ${params.itemId}:`, e);
    }
  }

  return toWrite.items[idx];
}

export async function completeItem(params: { requirementId: string; itemId: string; commit_sha?: string }): Promise<BacklogItem> {
  return setItemStatus({ requirementId: params.requirementId, itemId: params.itemId, status: 'done' });
}

export async function downgradeScope(params: { requirementId: string; itemId: string; from?: BacklogItemScope }): Promise<BacklogItem> {
  const req = await loadRequirement(params.requirementId);
  if (!req) throw new Error(`Requirement ${params.requirementId} not found`);
  const flow = getFlow(classifyRequirementType(req.type));
  const backlog = toBacklog(req.backlog, flow.phases[0]?.id || 'default');

  const idx = backlog.items.findIndex((i) => i.id === params.itemId);
  if (idx < 0) throw new Error(`Item ${params.itemId} not found`);
  const current = backlog.items[idx].scope_level;
  const next: BacklogItemScope = current === 'full' ? 'mvp' : current === 'mvp' ? 'minimal' : 'minimal';
  backlog.items[idx] = {
    ...backlog.items[idx],
    scope_level: next,
    status: 'pending',
    updated_at: new Date().toISOString(),
  };
  await writeBacklog(params.requirementId, backlog);
  return backlog.items[idx];
}

export async function logAssumption(params: { requirementId: string; itemId: string; assumption: string }): Promise<BacklogItem> {
  const req = await loadRequirement(params.requirementId);
  if (!req) throw new Error(`Requirement ${params.requirementId} not found`);
  const flow = getFlow(classifyRequirementType(req.type));
  const backlog = toBacklog(req.backlog, flow.phases[0]?.id || 'default');

  const idx = backlog.items.findIndex((i) => i.id === params.itemId);
  if (idx < 0) throw new Error(`Item ${params.itemId} not found`);
  const assumptions = backlog.items[idx].assumptions || [];
  backlog.items[idx] = {
    ...backlog.items[idx],
    assumptions: [...assumptions, params.assumption].slice(-20),
    updated_at: new Date().toISOString(),
  };
  await writeBacklog(params.requirementId, backlog);
  return backlog.items[idx];
}

export async function markNeedsReview(params: { requirementId: string; itemId: string; reason?: string }): Promise<BacklogItem> {
  return setItemStatus({ ...params, status: 'needs_review' });
}

export function pendingInPhase(backlog: RequirementBacklog, phaseId: string, limit: number = 3): BacklogItem[] {
  return backlog.items
    .filter((i) => i.phase_id === phaseId && i.status === 'pending')
    .slice(0, limit);
}

export function currentInProgress(backlog: RequirementBacklog): BacklogItem | null {
  return backlog.items.find((i) => i.status === 'in_progress') ?? null;
}

/**
 * True when a real user message (instance_logs.log_type='user_action') was
 * recorded for this requirement's runner instance AFTER the gating backlog
 * was completed. That user message is explicit permission to expand the
 * backlog, so the upsert gate may let new items through. Without it, the
 * agent could keep inventing items autonomously after closure (infinite
 * backlog) — which is exactly what the gate must prevent.
 */
export async function hasUserRequestedMoreWork(requirementId: string): Promise<boolean> {
  const { supabaseAdmin } = await import('@/lib/database/supabase-server');
  const { data: req } = await supabaseAdmin
    .from('requirements')
    .select('metadata, backlog')
    .eq('id', requirementId)
    .single();

  const instanceId = (req?.metadata as Record<string, any>)?.runner_instance_id as string | undefined;
  if (!instanceId) return false;

  const { data: ua } = await supabaseAdmin
    .from('instance_logs')
    .select('created_at')
    .eq('instance_id', instanceId)
    .eq('log_type', 'user_action')
    .order('created_at', { ascending: false })
    .limit(1);
  if (!ua || ua.length === 0) return false;

  const lastUserActionTime = new Date(ua[0].created_at).getTime();
  const backlogData = req?.backlog as Record<string, any> | undefined;
  const items = (backlogData?.items || []) as BacklogItem[];
  const gating = gatingItems(items);
  const completedTime = gating.length
    ? Math.max(...gating.map((i: any) => new Date(i.updated_at || 0).getTime()))
    : 0;

  // The user asked for something after the backlog was already done.
  return lastUserActionTime >= completedTime;
}
