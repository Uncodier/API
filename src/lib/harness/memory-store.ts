import type { HarnessSession, SessionScope, SessionStore } from './types';
import { sameJson, sanitizeControlMessage, SessionStoreError, validateLease } from './store';

interface Row {
  scope: SessionScope;
  snapshot: HarnessSession;
  owner: string | null;
  expiresAt: number | null;
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const integer = (value: number, min: number, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;

/** The same storage boundaries as SQL; engine policy/budget decisions stay in the engine. */
export function validateSession(session: HarnessSession): void {
  const limits = session?.request?.limits;
  if (!session || !limits || typeof session.id !== 'string' || !session.id ||
      !['queued', 'running', 'completed', 'waiting', 'paused', 'failed', 'cancelled'].includes(session.status) ||
      !integer(session.version, 0) || !integer(session.turns, 0) || !integer(session.allocatedTokens, 0) || !integer(session.activeMs, 0) ||
      !integer(limits.maxTurns, 1, 1000) || !integer(limits.maxOutputTokens, 1, 131072) ||
      !integer(limits.maxTotalTokens, 1, 100_000_000) || !integer(limits.maxActiveMs, 1, 86_400_000) ||
      typeof session.request.objective !== 'string' || !session.request.objective.length || session.request.objective.length > 24_000 ||
      typeof session.request.repository?.url !== 'string' || !session.request.repository.url.length || session.request.repository.url.length > 4000 ||
      typeof session.createdAt !== 'string' || typeof session.updatedAt !== 'string' ||
      !Array.isArray(session.messages) || session.messages.length > 10_000 ||
      !Array.isArray(session.uncertainOperations) || session.uncertainOperations.length > 10_000 ||
      session.uncertainOperations.some(item => typeof item !== 'string' || item.length > 1000) ||
      session.messages.some(message => !['user', 'assistant', 'tool'].includes(message.role) || typeof message.content !== 'string') ||
      (session.workspace !== undefined && (session.workspace.provider !== 'vercel' || typeof session.workspace.id !== 'string' || !session.workspace.id || session.workspace.id.length > 1000 || typeof session.workspace.root !== 'string' || !session.workspace.root.startsWith('/'))) ||
      (session.pending !== undefined && (!session.pending || !session.pending.call || typeof session.pending.call.id !== 'string' ||
        typeof session.pending.call.name !== 'string' || typeof session.pending.call.arguments !== 'string' ||
        typeof session.pending.fingerprint !== 'string' || !['read', 'write'].includes(session.pending.effect))) ||
      Buffer.byteLength(JSON.stringify(session)) > 4_000_000) throw new SessionStoreError('invalid');
}

/** In-process only; no credentials, timers, provider clients or product state. */
export class MemorySessionStore implements SessionStore {
  private readonly rows = new Map<string, Row>();
  private readonly now: () => number;
  constructor(options: { now?: () => number } = {}) { this.now = options.now ?? Date.now; }

  private row(id: string, siteId: string): Row | undefined {
    const row = this.rows.get(id);
    return row?.scope.siteId === siteId ? row : undefined;
  }
  private update(row: Row, snapshot: HarnessSession): HarnessSession {
    if (!integer(row.snapshot.version + 1, 1)) throw new SessionStoreError('invalid');
    row.snapshot = clone({ ...snapshot, version: row.snapshot.version + 1, updatedAt: new Date(this.now()).toISOString() });
    return clone(row.snapshot);
  }
  private owns(row: Row | undefined, owner: string): row is Row {
    return !!row && row.owner === owner && row.expiresAt !== null && row.expiresAt > this.now() && row.snapshot.status === 'running';
  }
  async create(session: HarnessSession, scope: SessionScope): Promise<void> {
    validateSession(session);
    if (!scope.siteId || !scope.userId || session.status !== 'queued' || session.version !== 0 ||
        session.turns !== 0 || session.allocatedTokens !== 0 || session.activeMs !== 0) throw new SessionStoreError('invalid');
    const row = this.rows.get(session.id);
    if (row) {
      if (!sameJson(row.scope, scope) || !sameJson(row.snapshot.request, session.request)) throw new SessionStoreError('conflict');
      return;
    }
    if (session.request.profile && [...this.rows.values()].some(candidate => candidate.scope.siteId === scope.siteId &&
      candidate.snapshot.request.profile === session.request.profile && !['completed', 'cancelled'].includes(candidate.snapshot.status))) {
      throw new SessionStoreError('conflict');
    }
    this.rows.set(session.id, { scope: clone(scope), snapshot: clone(session), owner: null, expiresAt: null });
  }
  async load(id: string, siteId: string): Promise<HarnessSession | null> { return clone(this.row(id, siteId)?.snapshot ?? null); }
  async claim(id: string, siteId: string, owner: string, ttlSeconds: number): Promise<HarnessSession | null> {
    validateLease(owner, ttlSeconds);
    const row = this.row(id, siteId);
    if (!row || !['queued', 'running'].includes(row.snapshot.status) ||
        (row.owner !== null && row.owner !== owner && row.expiresAt !== null && row.expiresAt > this.now())) return null;
    row.owner = owner; row.expiresAt = this.now() + ttlSeconds * 1000;
    return this.update(row, { ...row.snapshot, status: 'running' });
  }
  async save(session: HarnessSession, siteId: string, owner: string): Promise<HarnessSession> {
    validateLease(owner); validateSession(session);
    const row = this.row(session.id, siteId);
    if (!this.owns(row, owner) || row.snapshot.version !== session.version) throw new SessionStoreError('conflict');
    const previous = row.snapshot;
    if (session.status === 'queued' || !sameJson(previous.request, session.request) || previous.createdAt !== session.createdAt ||
        (previous.workspace !== undefined && !sameJson(previous.workspace, session.workspace)) ||
        session.turns < previous.turns || session.allocatedTokens < previous.allocatedTokens || session.activeMs < previous.activeMs ||
        previous.uncertainOperations.some(item => !session.uncertainOperations.includes(item))) throw new SessionStoreError('invalid');
    return this.update(row, session);
  }
  async assertOwner(id: string, siteId: string, owner: string, ttlSeconds: number): Promise<void> {
    validateLease(owner, ttlSeconds);
    const row = this.row(id, siteId);
    if (!this.owns(row, owner)) throw new SessionStoreError('conflict');
    row.expiresAt = this.now() + ttlSeconds * 1000;
  }
  async release(id: string, siteId: string, owner: string): Promise<void> {
    validateLease(owner);
    const row = this.row(id, siteId);
    if (row?.owner === owner) { row.owner = null; row.expiresAt = null; }
  }
  async control(id: string, siteId: string, action: 'pause' | 'cancel' | 'resume', message?: string): Promise<HarnessSession | null> {
    const text = sanitizeControlMessage(message);
    if (!['pause', 'cancel', 'resume'].includes(action)) throw new SessionStoreError('invalid');
    const row = this.row(id, siteId);
    if (!row) return null;
    const status = row.snapshot.status;
    if (status === 'completed' || status === 'cancelled' ||
        (action === 'resume' && row.expiresAt !== null && row.expiresAt > this.now())) return null;
    const next: HarnessSession = { ...row.snapshot, status: action === 'resume' ? 'queued' : action === 'pause' ? 'paused' : 'cancelled' };
    if (action === 'resume' && text) next.messages = [...next.messages, { role: 'user', content: text }];
    validateSession(next);
    row.owner = null; row.expiresAt = null;
    return this.update(row, next);
  }
}

export function createMemorySessionStore(options: { now?: () => number } = {}): MemorySessionStore {
  return new MemorySessionStore(options);
}