import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';

export class DeletionError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const uuid = z.string().uuid().transform(value => value.toLowerCase());
const requirementIds = z.array(uuid).max(1000).refine(ids => new Set(ids).size === ids.length);
const requestSchema = z.object({ instance_id: uuid, delete_requirements: z.literal(true) }).strict();
export const scopeSchema = z.object({
  instance_id: uuid,
  site_id: uuid,
  requirement_ids: requirementIds,
  provider: z.string().max(100).nullable(),
  provider_instance_id: z.string().max(200).nullable(),
  status: z.string().min(1).max(100),
});
export const resultSchema = z.object({ instance_id: uuid, deleted_requirement_ids: requirementIds });
export type DeletionScope = z.infer<typeof scopeSchema>;

/** A timeout cannot prove that a remote mutation did not commit. Never retry here. */
export function unconfirmedDeletion() {
  return new DeletionError(502, 'deletion_unconfirmed',
    'Deletion could not be confirmed. Refresh and verify the instance before trying again.');
}

export async function withSignal<T>(operation: () => PromiseLike<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(unconfirmedDeletion());
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([operation(), cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** Bound streamed bodies too; Content-Length alone is not a reliable limit. */
async function readBoundedText(message: Request | Response, limit: number, signal: AbortSignal) {
  if (Number(message.headers.get('content-length')) > limit) {
    void message.body?.cancel().catch(() => {});
    throw new Error('Body exceeds limit');
  }
  if (!message.body) return '';
  const reader = message.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await withSignal(() => reader.read(), signal);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new Error('Body exceeds limit');
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function readDeletionRequest(request: Request, signal: AbortSignal) {
  try {
    if (new URL(request.url).search || request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
      throw new Error('Invalid request');
    }
    return requestSchema.parse(JSON.parse(await readBoundedText(request, 4096, signal)));
  } catch {
    signal.throwIfAborted();
    throw new DeletionError(400, 'invalid_request', 'Provide a valid instance_id and delete_requirements: true.');
  }
}

/** Only a verified user bearer is forwarded; no middleware identity or service-role fallback. */
export async function requireDeletionUser(request: Request, signal: AbortSignal) {
  const match = /^Bearer ([A-Za-z0-9._~+/-]{32,4096}={0,2})$/i.exec(request.headers.get('authorization') || '');
  if (!match || request.headers.has('x-api-key')) {
    throw new DeletionError(401, 'unauthorized', 'An authenticated user bearer token is required.');
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!url || !key) throw new DeletionError(503, 'deletion_unavailable', 'User authorization is unavailable.');
  try {
    const client = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      global: {
        headers: { Authorization: `Bearer ${match[1]}` },
        fetch: async (input, options) => {
          const response = await withSignal(() => fetch(input, {
            ...options, signal, redirect: 'error', cache: 'no-store',
          }), signal);
          const text = await readBoundedText(response, 128 * 1024, signal);
          return new Response(text || null, {
            status: response.status, statusText: response.statusText, headers: response.headers,
          });
        },
      },
    });
    const { data, error } = await withSignal(() => client.auth.getUser(match[1]), signal);
    if (error && (error.status === 0 || (error.status && error.status >= 500) || error.name === 'AuthRetryableFetchError')) {
      throw new DeletionError(503, 'deletion_unavailable', 'User authorization is unavailable.');
    }
    if (error || !data?.user?.id || data.user.is_anonymous || data.user.role !== 'authenticated') {
      throw new DeletionError(401, 'unauthorized', 'User session is invalid or expired.');
    }
    return client;
  } catch (error) {
    if (error instanceof DeletionError) throw error;
    throw new DeletionError(503, 'deletion_unavailable', 'User authorization is unavailable.');
  }
}

export function rpcFailure(error: unknown, mutation: boolean): DeletionError {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  if (['PT401', 'PGRST301', 'PGRST302', 'PGRST303'].includes(String(code))) {
    return new DeletionError(401, 'unauthorized', 'User session is invalid or expired.');
  }
  if (code === 'PT403' || code === '42501') {
    return new DeletionError(403, 'forbidden', 'Only a site owner or administrator may delete this instance.');
  }
  if (code === 'PT404') return new DeletionError(404, 'not_found', 'Instance not found.');
  if (code === 'PT409') {
    return new DeletionError(409, 'deletion_conflict', 'Linked data is shared or has changed. Refresh before deleting.');
  }
  if (['PGRST202', 'PGRST203', '42883', '42P01', '42703'].includes(String(code))) {
    return new DeletionError(503, 'deletion_unavailable', 'Instance deletion is unavailable until the database migration is installed.');
  }
  if (!code) return mutation ? unconfirmedDeletion()
    : new DeletionError(503, 'deletion_unavailable', 'Instance deletion authorization is unavailable.');
  return new DeletionError(500, 'deletion_failed', 'The instance and its requirements could not be deleted.');
}

export async function stopDeletionProvider(scope: DeletionScope, signal: AbortSignal) {
  // The preflight also rejects execution leases and alternate sandbox handles before this no-provider path.
  if (scope.provider === null && scope.provider_instance_id === null) return;
  if (scope.status === 'uninstantiated' || scope.status === 'stopped') return;
  if (scope.provider !== 'scrapybara') {
    throw new DeletionError(409, 'unsupported_provider', 'Stop this instance with its provider before deleting it.');
  }
  if (!scope.provider_instance_id || !/^[A-Za-z0-9_-]{1,200}$/.test(scope.provider_instance_id)) {
    throw new DeletionError(409, 'deletion_conflict', 'Provider cleanup cannot be verified for this instance.');
  }
  const apiKey = process.env.SCRAPYBARA_API_KEY?.trim();
  if (!apiKey) throw new DeletionError(503, 'deletion_unavailable', 'Provider cleanup is unavailable.');
  try {
    const response = await withSignal(() => fetch(
      `https://api.scrapybara.com/v1/instance/${encodeURIComponent(scope.provider_instance_id!)}/stop`, {
        method: 'POST', headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
        signal, redirect: 'error', cache: 'no-store',
      },
    ), signal);
    // The stop API uses HTTP success; never read or expose its unbounded error body.
    void response.body?.cancel().catch(() => {});
    if (!response.ok) throw new Error('Provider stop failed');
  } catch {
    throw new DeletionError(502, 'provider_stop_failed',
      'Provider stop could not be confirmed. No database deletion was attempted. Verify provider state before trying again.');
  }
}