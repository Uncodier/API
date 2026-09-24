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
  productAttemptLimits,
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
} from './requirement-backlog-store';
import {
  assertBacklogGraph,
  assertBacklogInvariants,
  assertBacklogStatusTransition,
} from './requirement-backlog-invariants';
import { mutateBacklogAtomically } from './requirement-backlog-mutation';
import { validateAcceptance } from './requirement-acceptance';
import {
  acceptanceContractIsExecutable,
  isDeclaredAcceptanceContract,
  normalizeAcceptanceContractForPersistence,
} from './requirement-acceptance-contract';
import { cancelPlanStepsForBacklogItem } from '@/lib/helpers/plan-lifecycle';
import { isBacklogItemRunnable } from './requirement-backlog-blockers';
import {
  fulfillPlanCancellationRequests,
  pendingPlanCancellation,
} from './requirement-plan-cancellation';
import { applyBacklogStatusLifecycle } from './requirement-review-quarantine';

export type { BacklogItem, BacklogItemStatus, BacklogItemKind, BacklogItemScope, BacklogItemTier, RequirementBacklog };

// Lifecycle helpers (watchdog + attempts + instance resolver) are re-exported
// so existing callers keep their import path stable after the refactor.
export {
  bumpItemAttempts,
  recordToolFailure,
  ensureInProgressItem,
  escalateStaleInProgressItems,
  resolveBacklogContextForInstance,
} from './requirement-backlog-watchdog';
export { hasUserRequestedMoreWork } from './requirement-backlog-user-action';

export function isItemTerminal(status: string): boolean {
  return status === 'done' || status === 'needs_review';
}

export function gatingItems(items: BacklogItem[]): BacklogItem[] {
  const core = items.filter((i) => (i.tier ?? 'core') === 'core');
  return core.length > 0 ? core : items;
}

export function isBacklogComplete(items: BacklogItem[]): boolean {
  const gating = gatingItems(items);
  return gating.length > 0 && gating.every((i) => i.status === 'done');
}

export function outstandingGatingItems(items: BacklogItem[]): BacklogItem[] {
  return gatingItems(items).filter((i) => !isItemTerminal(i.status) && i.status !== 'rejected');
}

export function hasOutstandingWork(items: BacklogItem[]): boolean {
  return items.some((i) => !isItemTerminal(i.status) && i.status !== 'rejected');
}

export function isOrnamentalOnlyOutstanding(items: BacklogItem[]): boolean {
  const hasWork = hasOutstandingWork(items);
  const coreHasWork = outstandingGatingItems(items).length > 0;
  return hasWork && !coreHasWork;
}

/**
 * True when every gating item completed successfully. `needs_review` is
 * scheduling-terminal but never counts as successful delivery.
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
  const acceptanceContract = normalizeAcceptanceContractForPersistence(
    partial.acceptance,
    partial.acceptance_contract,
  );
  return {
    id: partial.id || generateUUID(),
    title: partial.title.trim(),
    kind: partial.kind,
    phase_id: partial.phase_id,
    acceptance: partial.acceptance,
    acceptance_contract: acceptanceContract,
    touches: partial.touches,
    status: (partial.status as BacklogItemStatus) || 'pending',
    attempts: typeof partial.attempts === 'number' ? partial.attempts : 0,
    assumptions: partial.assumptions,
    scope_level: partial.scope_level || 'full',
    tier: partial.tier ?? 'core',
    depends_on: partial.depends_on,
    blocked_by: partial.blocked_by,
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
  allowLegacyContract?: boolean;
}): Promise<BacklogItem> {
  return mutateBacklogAtomically(
    params.requirementId,
    ({ backlog, flow }) => {
      const idx = params.item.id
        ? backlog.items.findIndex((item) => item.id === params.item.id)
        : -1;
      const requestedTier =
        params.item.tier ??
        (idx >= 0 ? backlog.items[idx].tier : undefined) ??
        'core';
      if (
        idx < 0 &&
        requestedTier === 'core' &&
        !isDeclaredAcceptanceContract(params.item.acceptance_contract) &&
        !params.allowLegacyContract
      ) {
        throw new Error(
          'New tier=core backlog items require a declared ' +
          'AcceptanceContractV2. Legacy contract compilation must be ' +
          'explicitly authorized for migration-only producers.',
        );
      }
      const next = ensureItemDefaults(
        idx >= 0 ? { ...backlog.items[idx], ...params.item } : params.item,
      );

      if ((next.tier ?? 'core') === 'core') {
        const declaredContract = isDeclaredAcceptanceContract(
          next.acceptance_contract,
        );
        const validation = declaredContract
          ? null
          : validateAcceptance(next.acceptance);
        const invalid =
          declaredContract
            ? !acceptanceContractIsExecutable(next.acceptance_contract!)
            : !validation!.has_any_executable ||
              validation!.narrative.length > 0;
        if (invalid) {
          throw new Error(
            `Backlog upsert rejected: tier=core item "${next.title}" has ` +
              (
                declaredContract
                  ? 'an incomplete declared acceptance contract. '
                  : `${validation!.narrative.length}/${next.acceptance.length} narrative acceptance entries. `
              ) +
              'Provide one typed executable claim per criterion. Legacy entries must include an HTTP verb, ' +
              'route, status code, or observable behavior. Or set tier=ornamental.',
          );
        }
      }

      if (idx >= 0) backlog.items[idx] = next;
      else backlog.items.push(next);
      assertBacklogInvariants(
        backlog.items,
        flow.phases.map((phase) => phase.id),
      );
      reconcilePhaseForItem(backlog, flow, next);
      backlog.completion_ratio = computeRatio(backlog.items);
      return { result: next };
    },
  );
}

/**
 * Suspends an active item behind mandatory remediation work.
 *
 * The parent remains incomplete and cannot be selected again until every
 * dependency is successfully done. Its old plan steps are cancelled so the
 * orchestrator creates a focused plan for the remediation item next cycle.
 */
export async function suspendItemForRemediation(params: {
  requirementId: string;
  itemId: string;
  remediationItemIds: string[];
  reason: string;
}): Promise<BacklogItem | null> {
  const dependencyIds = Array.from(new Set(params.remediationItemIds))
    .filter((id) => id);
  if (dependencyIds.length === 0) return null;

  const suspended = await mutateBacklogAtomically(
    params.requirementId,
    ({ backlog, flow }) => {
      const parentIndex = backlog.items.findIndex(
        (item) => item.id === params.itemId,
      );
      if (parentIndex < 0) return { result: null, write: false };

      const parent = backlog.items[parentIndex];
      const nextDependencies = Array.from(new Set([
        ...(parent.depends_on || []),
        ...dependencyIds,
      ]));
      const graphProbe = backlog.items.map((item, index) =>
        index === parentIndex
          ? { ...item, depends_on: nextDependencies }
          : item,
      );
      const phaseOrder = flow.phases.map((phase) => phase.id);
      assertBacklogGraph(graphProbe, phaseOrder);

      const knownDependencies = dependencyIds.filter((id) =>
        backlog.items.some((item) => item.id === id && item.status !== 'done'),
      );
      if (knownDependencies.length === 0) {
        return { result: null, write: false };
      }

      backlog.items[parentIndex] = {
        ...parent,
        status: 'pending',
        depends_on: Array.from(new Set([
          ...(parent.depends_on || []),
          ...knownDependencies,
        ])),
        assumptions: Array.from(new Set([
          ...(parent.assumptions || []),
          `[remediation] ${params.reason}`,
        ])).slice(-20),
        updated_at: new Date().toISOString(),
      };
      assertBacklogInvariants(backlog.items, phaseOrder);
      for (const dependencyId of knownDependencies) {
        const dependency = backlog.items.find((item) => item.id === dependencyId);
        if (dependency) reconcilePhaseForItem(backlog, flow, dependency);
      }
      backlog.completion_ratio = computeRatio(backlog.items);
      return { result: backlog.items[parentIndex] };
    },
  );
  if (!suspended) return null;

  const cancellation = await cancelPlanStepsForBacklogItem({
    requirementId: params.requirementId,
    itemId: params.itemId,
    reason: `Suspended for mandatory remediation: ${params.reason}`.slice(0, 240),
  });
  if (cancellation.errors.length > 0) {
    throw new Error(
      `Could not suspend plan steps for ${params.itemId}: ${cancellation.errors.join('; ')}`,
    );
  }

  return suspended;
}

function assertProductAttemptAvailable(
  item: BacklogItem,
  limits: { core: number; ornamental: number },
): void {
  const limit = (item.tier ?? 'core') === 'ornamental'
    ? limits.ornamental
    : limits.core;
  if ((item.attempts || 0) >= limit) {
    throw new Error(`Item ${item.id} exhausted its ${limit} product attempts`);
  }
}

export async function markInProgress(params: { requirementId: string; itemId: string }): Promise<BacklogItem> {
  return mutateBacklogAtomically(
    params.requirementId,
    ({ backlog, flow }) => {
      const idx = backlog.items.findIndex((item) => item.id === params.itemId);
      if (idx < 0) throw new Error(`Item ${params.itemId} not found`);
      const item = backlog.items[idx];
      if (item.status === 'pending') {
        assertProductAttemptAvailable(item, productAttemptLimits(flow));
      }
      assertBacklogStatusTransition(backlog.items, params.itemId, 'in_progress');
      backlog.items[idx] = {
        ...backlog.items[idx],
        status: 'in_progress',
        updated_at: new Date().toISOString(),
      };
      assertBacklogInvariants(
        backlog.items,
        flow.phases.map((phase) => phase.id),
      );
      return { result: backlog.items[idx] };
    },
  );
}

export function hasApprovedJudgeEvidence(item: Pick<BacklogItem, 'evidence'>): boolean {
  return item.evidence?.judge_verdict === 'approved';
}

export async function setItemStatus(params: {
  requirementId: string;
  itemId: string;
  status: BacklogItemStatus;
  reason?: string;
  allowDoneReopen?: boolean;
}): Promise<BacklogItem> {
  const item = await mutateBacklogAtomically(
    params.requirementId,
    ({ requirement, backlog, flow }) => {
      const idx = backlog.items.findIndex((candidate) => candidate.id === params.itemId);
      if (idx < 0) throw new Error(`Item ${params.itemId} not found`);
      if (
        params.status === 'in_progress' &&
        backlog.items[idx].status === 'pending'
      ) {
        assertProductAttemptAvailable(
          backlog.items[idx],
          productAttemptLimits(flow),
        );
      }
      assertBacklogStatusTransition(
        backlog.items,
        params.itemId,
        params.status,
        {
          allowDoneReopen: params.allowDoneReopen,
        },
      );
      if (params.status === 'done' && !hasApprovedJudgeEvidence(backlog.items[idx])) {
        throw new Error(
          `Cannot mark backlog item ${params.itemId} done without an approved Judge verdict`,
        );
      }
      backlog.items[idx] = applyBacklogStatusLifecycle({
        item: backlog.items[idx],
        status: params.status,
        reason: params.reason,
        externalActionRevision:
          Number(requirement.external_user_action_revision) || 0,
        now: new Date().toISOString(),
      });
      assertBacklogInvariants(
        backlog.items,
        flow.phases.map((phase) => phase.id),
      );
      backlog.completion_ratio = computeRatio(backlog.items);
      const advance = advancePhaseIfReadyInMemory(backlog, flow);
      const toWrite = advance ? advance.nextBacklog : backlog;
      return { result: toWrite.items[idx], backlog: toWrite };
    },
  );

  // Stop zombie plan loops: when the item leaves the actively-worked tier
  // toward a non-success terminal (needs_review / rejected), any pending or
  // in_progress plan steps still bound to it must be cancelled. Otherwise
  // `cron-execute-steps-phase` keeps running the same subgoals every tick.
  // (For `done` we leave the plan alone — its steps should already be
  // completing naturally as the work lands.)
  if (params.status === 'needs_review' || params.status === 'rejected') {
    const request = pendingPlanCancellation(item);
    await fulfillPlanCancellationRequests({
      requirementId: params.requirementId,
      requests: request ? [request] : [],
    });
  }

  return item;
}

export async function completeItem(params: { requirementId: string; itemId: string; commit_sha?: string }): Promise<BacklogItem> {
  return setItemStatus({ requirementId: params.requirementId, itemId: params.itemId, status: 'done' });
}

export async function downgradeScope(params: { requirementId: string; itemId: string; from?: BacklogItemScope }): Promise<BacklogItem> {
  return mutateBacklogAtomically(
    params.requirementId,
    ({ backlog, flow }) => {
      const idx = backlog.items.findIndex((item) => item.id === params.itemId);
      if (idx < 0) throw new Error(`Item ${params.itemId} not found`);
      assertBacklogStatusTransition(backlog.items, params.itemId, 'pending');
      const current = backlog.items[idx].scope_level;
      const next: BacklogItemScope =
        current === 'full' ? 'mvp' : current === 'mvp' ? 'minimal' : 'minimal';
      backlog.items[idx] = {
        ...backlog.items[idx],
        scope_level: next,
        status: 'pending',
        updated_at: new Date().toISOString(),
      };
      assertBacklogInvariants(
        backlog.items,
        flow.phases.map((phase) => phase.id),
      );
      backlog.completion_ratio = computeRatio(backlog.items);
      return { result: backlog.items[idx] };
    },
  );
}

export async function logAssumption(params: { requirementId: string; itemId: string; assumption: string }): Promise<BacklogItem> {
  return mutateBacklogAtomically(
    params.requirementId,
    ({ backlog }) => {
      const idx = backlog.items.findIndex((item) => item.id === params.itemId);
      if (idx < 0) throw new Error(`Item ${params.itemId} not found`);
      const assumptions = backlog.items[idx].assumptions || [];
      backlog.items[idx] = {
        ...backlog.items[idx],
        assumptions: [...assumptions, params.assumption].slice(-20),
        updated_at: new Date().toISOString(),
      };
      return { result: backlog.items[idx] };
    },
  );
}

export async function markNeedsReview(params: { requirementId: string; itemId: string; reason?: string }): Promise<BacklogItem> {
  return setItemStatus({ ...params, status: 'needs_review' });
}

export function pendingInPhase(backlog: RequirementBacklog, phaseId: string, limit: number = 3): BacklogItem[] {
  const completedIds = new Set(
    backlog.items
      .filter((item) => item.status === 'done')
      .map((item) => item.id),
  );
  return backlog.items
    .filter(
      (item) =>
        item.phase_id === phaseId &&
        isBacklogItemRunnable(item, completedIds),
    )
    .slice(0, limit);
}

export function currentInProgress(backlog: RequirementBacklog): BacklogItem | null {
  return backlog.items.find((i) => i.status === 'in_progress') ?? null;
}
