/**
 * Backlog service — reads/writes `requirements.metadata.backlog` with the
 * WIP=1 rule enforced. The backlog is agnostic to requirement kind; phase ids
 * come from the flow registry (`requirement-flows.ts`).
 */

import { supabaseAdmin } from '@/lib/database/supabase-client';
import {
  classifyRequirementType,
  getFlow,
  advancePhaseIfReadyInMemory,
  type RequirementKind,
} from './requirement-flows';
import {
  emptyBacklog,
  type BacklogItem,
  type BacklogItemKind,
  type BacklogItemScope,
  type BacklogItemStatus,
  type RequirementBacklog,
} from './requirement-backlog-types';

export type { BacklogItem, BacklogItemStatus, BacklogItemKind, BacklogItemScope, RequirementBacklog };

interface RequirementRow {
  id: string;
  type: string | null;
  metadata: Record<string, any> | null;
}

async function loadRequirement(requirementId: string): Promise<RequirementRow | null> {
  const { data } = await supabaseAdmin
    .from('requirements')
    .select('id, type, metadata')
    .eq('id', requirementId)
    .maybeSingle();
  return (data as RequirementRow) ?? null;
}

function toBacklog(metadata: Record<string, any> | null, defaultPhase: string): RequirementBacklog {
  const raw = (metadata?.backlog as RequirementBacklog | undefined) ?? null;
  if (!raw) return emptyBacklog(defaultPhase);
  return {
    schema_version: 1,
    items: Array.isArray(raw.items) ? raw.items : [],
    current_phase_id: raw.current_phase_id || defaultPhase,
    completion_ratio: typeof raw.completion_ratio === 'number' ? raw.completion_ratio : 0,
    cycles_spent_total: typeof raw.cycles_spent_total === 'number' ? raw.cycles_spent_total : 0,
  };
}

async function writeBacklog(requirementId: string, backlog: RequirementBacklog, existingMetadata: Record<string, any> | null) {
  const metadata = { ...(existingMetadata || {}), backlog };
  const { error } = await supabaseAdmin.from('requirements').update({ metadata }).eq('id', requirementId);
  if (error) throw new Error(`Failed to persist backlog: ${error.message}`);
}

function computeRatio(items: BacklogItem[]): number {
  if (!items.length) return 0;
  const done = items.filter((i) => i.status === 'done').length;
  return Math.round((done / items.length) * 1000) / 1000;
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
    backlog: toBacklog(req.metadata, flow.phases[0]?.id || 'default'),
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
  const backlog = toBacklog(req.metadata, flow.phases[0]?.id || 'default');

  const idx = params.item.id ? backlog.items.findIndex((i) => i.id === params.item.id) : -1;
  const next = ensureItemDefaults(
    idx >= 0 ? { ...backlog.items[idx], ...params.item } : params.item,
  );
  if (idx >= 0) {
    backlog.items[idx] = next;
  } else {
    backlog.items.push(next);
  }
  backlog.completion_ratio = computeRatio(backlog.items);
  await writeBacklog(params.requirementId, backlog, req.metadata);
  return next;
}

export async function markInProgress(params: { requirementId: string; itemId: string }): Promise<BacklogItem> {
  const req = await loadRequirement(params.requirementId);
  if (!req) throw new Error(`Requirement ${params.requirementId} not found`);
  const flow = getFlow(classifyRequirementType(req.type));
  const backlog = toBacklog(req.metadata, flow.phases[0]?.id || 'default');

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
  await writeBacklog(params.requirementId, backlog, req.metadata);
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
  const backlog = toBacklog(req.metadata, flow.phases[0]?.id || 'default');

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

  await writeBacklog(params.requirementId, toWrite, req.metadata);
  return toWrite.items[idx];
}

export async function completeItem(params: { requirementId: string; itemId: string; commit_sha?: string }): Promise<BacklogItem> {
  return setItemStatus({ requirementId: params.requirementId, itemId: params.itemId, status: 'done' });
}

export async function downgradeScope(params: { requirementId: string; itemId: string; from?: BacklogItemScope }): Promise<BacklogItem> {
  const req = await loadRequirement(params.requirementId);
  if (!req) throw new Error(`Requirement ${params.requirementId} not found`);
  const flow = getFlow(classifyRequirementType(req.type));
  const backlog = toBacklog(req.metadata, flow.phases[0]?.id || 'default');

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
  await writeBacklog(params.requirementId, backlog, req.metadata);
  return backlog.items[idx];
}

export async function logAssumption(params: { requirementId: string; itemId: string; assumption: string }): Promise<BacklogItem> {
  const req = await loadRequirement(params.requirementId);
  if (!req) throw new Error(`Requirement ${params.requirementId} not found`);
  const flow = getFlow(classifyRequirementType(req.type));
  const backlog = toBacklog(req.metadata, flow.phases[0]?.id || 'default');

  const idx = backlog.items.findIndex((i) => i.id === params.itemId);
  if (idx < 0) throw new Error(`Item ${params.itemId} not found`);
  const assumptions = backlog.items[idx].assumptions || [];
  backlog.items[idx] = {
    ...backlog.items[idx],
    assumptions: [...assumptions, params.assumption].slice(-20),
    updated_at: new Date().toISOString(),
  };
  await writeBacklog(params.requirementId, backlog, req.metadata);
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
