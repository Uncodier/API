import type { Sandbox } from '@vercel/sandbox';

export const SANDBOX_CREDITS_PER_HOUR = 0.5;
export class SandboxBillingError extends Error {
  constructor() { super('Sandbox billing could not be reconciled. Active usage remains pending.'); this.name = 'SandboxBillingError'; }
}
export type SandboxBillingOwner = { kind: 'harness' | 'requirement' | 'workflow'; id: string; siteId?: string };
type BillingClient = { rpc(name: string, params: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> };
async function client(): Promise<BillingClient> {
  // Lazy: offline workspace-only callers need neither a DB nor host credentials.
  return (await import('@/lib/database/supabase-client')).supabaseAdmin;
}

/** Must precede create/resume. Site is resolved again inside the service-only RPC. */
export async function registerSandboxBilling(name: string, owner: SandboxBillingOwner, db?: BillingClient): Promise<void> {
  try {
    const result = await (db ?? await client()).rpc('register_sandbox_billing', {
      p_sandbox_name: name, p_owner_kind: owner.kind, p_owner_id: owner.id, p_site_id: owner.siteId ?? null,
    });
    if (result.error || !(result.data as { success?: boolean } | null)?.success) throw new SandboxBillingError();
  } catch { throw new SandboxBillingError(); }
}

export type ProviderSession = { id: string; status: string; startedAt?: number | Date;
  stoppedAt?: number | Date; abortedAt?: number | Date; duration?: number };
function milliseconds(value: number | Date | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(ms) || ms < 0) throw new SandboxBillingError();
  return ms;
}
export function billableSession(session: ProviderSession): { id: string; started_at: string; ended_at: string | null } | null {
  const start = milliseconds(session.startedAt);
  if (start === undefined) {
    if (session.status === 'pending' || session.status === 'failed' || session.status === 'aborted') return null;
    throw new SandboxBillingError(); // Incomplete running/stopped evidence is pending, never settled.
  }
  const stops = [milliseconds(session.stoppedAt), milliseconds(session.abortedAt)].filter((v): v is number => v !== undefined);
  let end = stops.length ? Math.min(...stops) : undefined;
  if (end === undefined && ['stopped', 'failed', 'aborted'].includes(session.status)) {
    if (session.duration === undefined) throw new SandboxBillingError();
    if (!Number.isFinite(session.duration) || session.duration < 0) throw new SandboxBillingError();
    end = start + session.duration;
  }
  if (!session.id || (end !== undefined && end < start)) throw new SandboxBillingError();
  return { id: session.id, started_at: new Date(start).toISOString(), ended_at: end === undefined ? null : new Date(end).toISOString() };
}

/** listSessions is control-plane only and DOES NOT implicitly resume a stopped VM.
 * Capture observation BEFORE the query so request latency cannot add stopped time. */
export async function reconcileSandboxBilling(sandbox: Sandbox, db?: BillingClient): Promise<void> {
  try { await reconcile(sandbox, db); } catch { throw new SandboxBillingError(); }
}

async function reconcile(sandbox: Sandbox, db?: BillingClient): Promise<void> {
  const observedAt = new Date().toISOString();
  if (typeof sandbox.listSessions !== 'function') throw new SandboxBillingError();
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 1000; page++) {
    const result = await sandbox.listSessions({ limit: 100, cursor, sortOrder: 'asc' });
    const intervals = result.sessions.map(billableSession).filter(v => v !== null);
    const billed = await (db ?? await client()).rpc('bill_sandbox_sessions', {
      p_sandbox_name: sandbox.name, p_sessions: intervals, p_observed_at: observedAt,
    });
    if (billed.error || !(billed.data as { success?: boolean } | null)?.success) throw new SandboxBillingError();
    const next = result.pagination.next;
    if (!next) {
      const completed=await (db ?? await client()).rpc('complete_sandbox_billing_observation',{p_sandbox_name:sandbox.name});
      if (completed.error || !(completed.data as {success?:boolean}|null)?.success) throw new SandboxBillingError();
      return;
    }
    if (seen.has(next)) throw new SandboxBillingError();
    seen.add(next); cursor = next;
  }
  throw new SandboxBillingError();
}

/** Cleanup must still stop on billing/DB outage. Do not claim settlement succeeded. */
export async function reconcileSandboxBillingQuiet(sandbox: Sandbox): Promise<boolean> {
  try { await reconcileSandboxBilling(sandbox); return true; }
  catch { console.warn('[SandboxBilling] Reconciliation pending; cleanup continues without advancing failed watermarks.'); return false; }
}

export async function retireSandboxBilling(name: string, phase: 'begin' | 'finish', db?: BillingClient): Promise<void> {
  try {
    const result=await (db ?? await client()).rpc('retire_sandbox_billing',{p_sandbox_name:name,p_phase:phase});
    if (result.error || !(result.data as { success?: boolean } | null)?.success) throw new SandboxBillingError();
  } catch { throw new SandboxBillingError(); }
}