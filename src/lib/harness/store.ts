import type { HarnessSession, SessionScope, SessionStore } from './types';
import { createRedactor } from './security';

/** Deliberately structural: tests can inject a client without importing Supabase. */
export interface SessionStoreClient {
  from(table: string): any;
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

export class SessionStoreError extends Error {
  constructor(public readonly code: 'invalid' | 'conflict' | 'storage') {
    super(`Harness session ${code}`);
    this.name = 'SessionStoreError';
  }
}

export function validateLease(owner: string, ttlSeconds?: number): void {
  if (typeof owner !== 'string' || !owner.trim() || owner.length > 200 ||
      (ttlSeconds !== undefined && (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 300))) {
    throw new SessionStoreError('invalid');
  }
}

/** Defense in depth; callers should also apply their configured secret redactor. */
export function sanitizeControlMessage(message?: string): string | undefined {
  if (message === undefined) return undefined;
  if (typeof message !== 'string' || message.length > 20_000) throw new SessionStoreError('invalid');
  return createRedactor()(message
    .replace(/\b(?:https?|postgres(?:ql)?):\/\/[^\s"<>]+/gi, value => {
      try {
        const url = new URL(value);
        url.username = ''; url.password = '';
        for (const key of [...url.searchParams.keys()]) {
          if (/token|key|secret|password|auth|credential/i.test(key)) url.searchParams.set(key, '[REDACTED]');
        }
        return url.toString();
      } catch { return '[REDACTED URL]'; }
    })
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/(["'](?:authorization|cookie|set-cookie|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)["']\s*:\s*["'])[^"']+(["'])/gi, '$1[REDACTED]$2')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')).slice(0, 20_000);
}

export function createSessionStore(client?: SessionStoreClient): SessionStore {
  let pending: Promise<SessionStoreClient> | undefined;
  const getClient = (): Promise<SessionStoreClient> => {
    if (client) return Promise.resolve(client);
    pending ??= import('../database/supabase-client').then(module => module.supabaseAdmin);
    return pending;
  };
  const rpc = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const { data, error } = await (await getClient()).rpc(name, args);
    // Never surface database error details: they can contain the input snapshot.
    if (error) throw new SessionStoreError('storage');
    return data;
  };
  return {
    async create(session: HarnessSession, scope: SessionScope) {
      const db = await getClient();
      const { error } = await db.from('harness_sessions').insert({
        id: session.id, site_id: scope.siteId, user_id: scope.userId,
        snapshot: session, version: session.version,
      });
      if (!error) return;
      if (error.code !== '23505') throw new SessionStoreError('storage');
      const existing = await db.from('harness_sessions').select('snapshot')
        .eq('id', session.id).eq('site_id', scope.siteId).eq('user_id', scope.userId).maybeSingle();
      if (existing.error) throw new SessionStoreError('storage');
      if (!existing.data || !sameJson(existing.data.snapshot.request, session.request)) throw new SessionStoreError('conflict');
    },
    async load(id, siteId) {
      const { data, error } = await (await getClient()).from('harness_sessions')
        .select('snapshot').eq('id', id).eq('site_id', siteId).maybeSingle();
      if (error) throw new SessionStoreError('storage');
      return data?.snapshot ?? null;
    },
    async claim(id, siteId, owner, ttlSeconds) {
      validateLease(owner, ttlSeconds);
      return await rpc('claim_harness_session', { p_id: id, p_site_id: siteId, p_owner: owner, p_ttl_seconds: ttlSeconds }) as HarnessSession | null;
    },
    async save(session, siteId, owner) {
      validateLease(owner);
      const saved = await rpc('save_harness_session', { p_id: session.id, p_site_id: siteId, p_owner: owner, p_snapshot: session });
      if (!saved) throw new SessionStoreError('conflict');
      return saved as HarnessSession;
    },
    async assertOwner(id, siteId, owner, ttlSeconds) {
      validateLease(owner, ttlSeconds);
      if (!await rpc('renew_harness_session', { p_id: id, p_site_id: siteId, p_owner: owner, p_ttl_seconds: ttlSeconds })) {
        throw new SessionStoreError('conflict');
      }
    },
    async release(id, siteId, owner) {
      validateLease(owner);
      await rpc('release_harness_session', { p_id: id, p_site_id: siteId, p_owner: owner });
    },
    async control(id, siteId, action, message) {
      return await rpc('control_harness_session', {
        p_id: id, p_site_id: siteId, p_action: action, p_message: sanitizeControlMessage(message) ?? null,
      }) as HarnessSession | null;
    },
  };
}

export function sameJson(left: unknown, right: unknown): boolean {
  const ordered = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(ordered);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, ordered(item)]));
    return value;
  };
  return JSON.stringify(ordered(left)) === JSON.stringify(ordered(right));
}