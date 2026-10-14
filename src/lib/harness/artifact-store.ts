import { createHash } from 'node:crypto';
import type { ArtifactStore, ResultArtifact, SessionStore } from './types';
import type { SessionStoreClient } from './store';
import { validateLease } from './store';

export const ARTIFACT_MAX_BYTES = 1024 * 1024;
export const ARTIFACT_SESSION_MAX_BYTES = 16 * ARTIFACT_MAX_BYTES;
export const ARTIFACT_PAGE_MAX_CHARS = 16_000;
interface ArtifactRow extends ResultArtifact { text: string; siteId: string }
interface MemoryArtifacts { artifacts: Map<string, ArtifactRow>; reservations: Map<string, number> }

export class ArtifactStoreError extends Error {
  constructor(public readonly code: 'invalid' | 'conflict' | 'storage' | 'quota') {
    super(code === 'quota' ? 'Harness artifact quota exceeded; complete result cannot be retained' :
      code === 'storage' ? 'Harness artifact storage unavailable; complete result was not confirmed durable; do not repeat side effects' :
        `Harness artifact ${code}`);
    this.name = 'ArtifactStoreError';
  }
}

function validateScope(id: string, siteId: string, owner: string): void {
  validateLease(owner);
  if (typeof id !== 'string' || !id || typeof siteId !== 'string' || !siteId) throw new ArtifactStoreError('invalid');
}

function artifact(sessionId: string, operationId: string, text: string): ResultArtifact {
  if (typeof operationId !== 'string' || !operationId || operationId.length > 1000 || operationId.includes('\0') ||
      typeof text !== 'string' || text.includes('\0')) throw new ArtifactStoreError('invalid');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > ARTIFACT_MAX_BYTES) throw new ArtifactStoreError('quota');
  // PostgreSQL text is Unicode, not arbitrary UTF-16. Reject lossy conversion rather than changing content.
  if (Buffer.from(text, 'utf8').toString('utf8') !== text || Buffer.from(operationId, 'utf8').toString('utf8') !== operationId) {
    throw new ArtifactStoreError('invalid');
  }
  const id = createHash('sha256').update(sessionId.toLowerCase(), 'utf8').update('\0')
    .update(operationId, 'utf8').update('\0').update(text, 'utf8').digest('hex');
  return { id, bytes, chars: text.length };
}

function validatePage(id: string, offset: number, limit: number): void {
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id) || !Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > ARTIFACT_PAGE_MAX_CHARS) throw new ArtifactStoreError('invalid');
}

function validateReservation(operationId: string, bytes: number): void {
  if (typeof operationId !== 'string' || !operationId || operationId.length > 1000 || operationId.includes('\0') ||
      Buffer.from(operationId, 'utf8').toString('utf8') !== operationId ||
      !Number.isSafeInteger(bytes) || bytes < 1 || bytes > ARTIFACT_MAX_BYTES) throw new ArtifactStoreError('invalid');
}

function page(text: string, offset: number, limit: number) {
  const end = Math.min(text.length, offset + limit);
  return { text: text.slice(offset, end), totalChars: text.length, nextOffset: end < text.length ? end : null };
}

/** Caller MUST redact before put. Only the complete redacted result belongs here, never host configuration. */
export function createArtifactStore(client?: Pick<SessionStoreClient, 'rpc'>): ArtifactStore {
  let pending: Promise<Pick<SessionStoreClient, 'rpc'>> | undefined;
  const rpc = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    try {
      const db: Pick<SessionStoreClient, 'rpc'> = client ?? await (pending ??= import('../database/supabase-client').then(module => module.supabaseAdmin));
      const { data, error } = await db.rpc(name, args);
      if (error) {
        const code = (error as { code?: string }).code;
        throw new ArtifactStoreError(code === 'P0002' ? 'conflict' : code === '54000' ? 'quota' : code === '22023' ? 'invalid' : 'storage');
      }
      return data;
    } catch (error) {
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactStoreError('storage');
    }
  };
  return {
    async reserve(sessionId, siteId, owner, operationId, bytes) {
      validateScope(sessionId, siteId, owner); validateReservation(operationId, bytes);
      if (await rpc('reserve_harness_artifact', { p_id: sessionId, p_site_id: siteId, p_owner: owner,
        p_operation_id: operationId, p_bytes: bytes }) !== true) throw new ArtifactStoreError('storage');
    },
    async put(sessionId, siteId, owner, operationId, text) {
      validateScope(sessionId, siteId, owner);
      const expected = artifact(sessionId, operationId, text);
      const stored = await rpc('put_harness_artifact', { p_id: sessionId, p_site_id: siteId, p_owner: owner,
        p_operation_id: operationId, p_artifact_id: expected.id, p_text: text }) as ResultArtifact | null;
      if (!stored || stored.id !== expected.id || stored.bytes !== expected.bytes || stored.chars !== expected.chars) {
        throw new ArtifactStoreError('storage');
      }
      return { ...expected };
    },
    async read(sessionId, siteId, owner, id, offset, limit) {
      validateScope(sessionId, siteId, owner); validatePage(id, offset, limit);
      // Fetch <=1 MiB through an owner-guarded RPC, then slice UTF-16 in the host.
      // SQL substring counts Unicode code points and cannot implement JS char offsets.
      const result = await rpc('read_harness_artifact', { p_id: sessionId, p_site_id: siteId, p_owner: owner, p_artifact_id: id }) as { text: string } | null;
      if (result === null) return null;
      if (!result || typeof result.text !== 'string' || Buffer.byteLength(result.text, 'utf8') > ARTIFACT_MAX_BYTES) {
        throw new ArtifactStoreError('storage');
      }
      return page(result.text, offset, limit);
    },
  };
}

const memoryRows = new WeakMap<SessionStore, Map<string, MemoryArtifacts>>();
export function createMemoryArtifactStore(sessionStore: SessionStore): ArtifactStore {
  let rows = memoryRows.get(sessionStore);
  if (!rows) { rows = new Map(); memoryRows.set(sessionStore, rows); }
  const storage = rows;
  const usage = (session?: MemoryArtifacts) => [...(session?.artifacts.values() ?? [])].reduce((sum, row) => sum + row.bytes, 0) +
    [...(session?.reservations.values() ?? [])].reduce((sum, bytes) => sum + bytes, 0);
  const getSession = (id: string): MemoryArtifacts => {
    let session = storage.get(id);
    if (!session) { session = { artifacts: new Map(), reservations: new Map() }; storage.set(id, session); }
    return session;
  };
  return {
    async reserve(sessionId, siteId, owner, operationId, bytes) {
      validateScope(sessionId, siteId, owner); validateReservation(operationId, bytes);
      await sessionStore.assertOwner(sessionId, siteId, owner, 180);
      const existing = storage.get(sessionId);
      const previous = existing?.reservations.get(operationId);
      if (previous !== undefined && previous >= bytes) return;
      if (usage(existing) - (previous ?? 0) + bytes > ARTIFACT_SESSION_MAX_BYTES) throw new ArtifactStoreError('quota');
      getSession(sessionId).reservations.set(operationId, bytes);
    },
    async put(sessionId, siteId, owner, operationId, text) {
      validateScope(sessionId, siteId, owner);
      const result = artifact(sessionId, operationId, text);
      await sessionStore.assertOwner(sessionId, siteId, owner, 180);
      let session = storage.get(sessionId);
      const existing = session?.artifacts.get(result.id);
      if (existing) {
        if (existing.siteId !== siteId || existing.text !== text) throw new ArtifactStoreError('conflict');
        session!.reservations.set(operationId, 0);
        return result;
      }
      if (usage(session) - (session?.reservations.get(operationId) ?? 0) + result.bytes > ARTIFACT_SESSION_MAX_BYTES) throw new ArtifactStoreError('quota');
      session ??= getSession(sessionId);
      session.artifacts.set(result.id, { ...result, text, siteId });
      session.reservations.set(operationId, 0);
      return result;
    },
    async read(sessionId, siteId, owner, id, offset, limit) {
      validateScope(sessionId, siteId, owner); validatePage(id, offset, limit);
      await sessionStore.assertOwner(sessionId, siteId, owner, 180);
      const row = storage.get(sessionId)?.artifacts.get(id);
      if (!row || row.siteId !== siteId) return null;
      return page(row.text, offset, limit);
    },
  };
}