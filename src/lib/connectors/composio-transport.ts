import { ConnectorError } from './types';
import { executionRequestFailure } from './provider-outcome';

const BASE_URL = 'https://backend.composio.dev/api/v3.1';
export const COMPOSIO_TIMEOUT_MS = 10_000;
export const COMPOSIO_MAX_RESPONSE_BYTES = 1_048_576;
const MAX_REQUEST_BYTES = 65_536;
type Method = 'GET' | 'POST';
export type ComposioClient = {
  request<T = unknown>(path: string, options?: { method?: Method; body?: unknown }): Promise<T>;
};

// Deliberately excludes proxies, files, bulk calls, meta tools and org APIs.
const ROUTES: Array<{ method: Method; path: RegExp; query: string[] }> = [
  { method: 'GET', path: /^\/tools$/, query: ['toolkit_slug', 'limit', 'cursor', 'include_deprecated', 'query', 'tool_slugs', 'tags'] },
  { method: 'GET', path: /^\/toolkits$/, query: ['search', 'category', 'cursor', 'limit', 'type', 'sort_by'] },
  { method: 'GET', path: /^\/toolkits\/[a-z0-9_-]{1,100}$/, query: [] },
  { method: 'GET', path: /^\/auth_configs$/, query: ['toolkit_slug', 'show_disabled', 'limit', 'cursor'] },
  { method: 'POST', path: /^\/auth_configs$/, query: [] },
  { method: 'GET', path: /^\/connected_accounts$/, query: ['user_ids', 'connected_account_ids', 'cursor', 'limit'] },
  { method: 'POST', path: /^\/connected_accounts$/, query: [] },
  { method: 'GET', path: /^\/connected_accounts\/[a-zA-Z0-9_-]{1,200}$/, query: [] },
  { method: 'POST', path: /^\/connected_accounts\/(link|complete_auth)$/, query: [] },
  { method: 'POST', path: /^\/connected_accounts\/[a-zA-Z0-9_-]{1,200}\/revoke$/, query: [] },
  { method: 'POST', path: /^\/tool_router\/session$/, query: [] },
  { method: 'GET', path: /^\/tool_router\/session\/[a-zA-Z0-9_-]{1,200}\/tools$/, query: ['limit', 'cursor'] },
  { method: 'GET', path: /^\/tools\/(?!COMPOSIO_)[A-Z0-9_]{1,150}$/, query: ['version'] },
  { method: 'POST', path: /^\/tools\/execute\/(?!COMPOSIO_)[A-Z0-9_]{1,150}$/, query: [] },
];

export function invalidInput(): never {
  throw new ConnectorError('CONNECTOR_INVALID_INPUT', 'Invalid connector provider request.', 400);
}

export function invalidProviderResponse(write = false): never {
  throw new ConnectorError(
    write ? 'CONNECTOR_OUTCOME_UNKNOWN' : 'PROVIDER_INVALID_RESPONSE',
    write ? 'The provider outcome is unknown. Reconcile before trying again.' : 'The provider returned an unsupported response.',
    502,
  );
}

function validatePath(path: string, method: Method): string {
  if (typeof path !== 'string' || path.length > 4096 || !path.startsWith('/') || /[\\#\s]/.test(path)) invalidInput();
  const [pathname, query = '', ...rest] = path.split('?');
  if (rest.length) invalidInput();
  const route = ROUTES.find(rule => rule.method === method && rule.path.test(pathname));
  if (!route) invalidInput();
  const params = new URLSearchParams(query);
  const seen = new Set<string>();
  for (const [key, value] of params) {
    if (!route.query.includes(key) || seen.has(key) || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) invalidInput();
    if (key === 'limit' && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100)) invalidInput();
    seen.add(key);
  }
  return `${BASE_URL}${pathname}${query ? `?${params.toString()}` : ''}`;
}

/** Plain bounded JSON only: no SDK serialization hooks, streams, paths or file loaders. */
export function validateJson(value: unknown, maxDepth = 20): void {
  let nodes = 0;
  const ancestors = new Set<object>();
  function visit(item: unknown, depth: number): void {
    if (++nodes > 10_000 || depth > maxDepth) invalidInput();
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item === 'string' && item.length <= MAX_REQUEST_BYTES) return;
    if (!item || typeof item !== 'object' || ancestors.has(item)) invalidInput();
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) invalidInput();
    ancestors.add(item);
    for (const key of Object.keys(item)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) invalidInput();
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !('value' in descriptor)) invalidInput();
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
  }
  visit(value, 0);
}

async function readJson(response: Response, write: boolean, maxBytes = COMPOSIO_MAX_RESPONSE_BYTES, signal?: AbortSignal): Promise<unknown> {
  const type = response.headers.get('content-type') || '';
  if (!/^application\/(?:[a-z0-9.-]+\+)?json(?:\s*;|$)/i.test(type)) invalidProviderResponse(write);
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) invalidProviderResponse(write);
  if (!response.body) invalidProviderResponse(write);
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) invalidProviderResponse(write);
      if (value.byteLength) chunks.push(value);
    }
    const text = Buffer.concat(chunks, bytes).toString('utf8');
    try { return JSON.parse(text); } catch { invalidProviderResponse(write); }
  } finally {
    // Cancellation is deliberately not awaited; a broken upstream must not hang cleanup.
    signal?.removeEventListener('abort', cancel);
    cancel();
  }
}

function httpError(status: number, write: boolean, retryAfter: string | null): never {
  if (write && (status >= 500 || status === 408)) invalidProviderResponse(true);
  const errors: Record<number, [string, string, number]> = {
    401: ['PROVIDER_AUTH_FAILED', 'The connector provider credential was rejected.', 502],
    403: ['PROVIDER_FORBIDDEN', 'The provider denied this operation.', 403],
    404: ['PROVIDER_NOT_FOUND', 'The requested provider resource is unavailable.', 404],
    429: ['PROVIDER_RATE_LIMITED', 'The provider request limit was reached.', 429],
  };
  const error = errors[status] || (status >= 500
    ? ['PROVIDER_UNAVAILABLE', 'The connector provider is unavailable.', 502] as const
    : ['PROVIDER_REJECTED', 'The provider did not accept this operation.', 502] as const);
  const failure = new ConnectorError(error[0], error[1], error[2]);
  if (status === 429 && retryAfter !== null && /^\d{1,6}$/.test(retryAfter) && Number(retryAfter) <= 86_400) {
    Object.assign(failure, { retryAfterSeconds: Number(retryAfter) });
  }
  throw failure;
}

/** A client is short-lived and belongs to one authorized request; never cache it globally. */
export function createComposioClient(apiKey: string): ComposioClient {
  if (typeof apiKey !== 'string' || apiKey.length < 1 || apiKey.length > 4096 || !/^[\x21-\x7e]+$/.test(apiKey)) {
    throw new ConnectorError('PROVIDER_SETUP_REQUIRED', 'A valid site connector credential is required.', 503);
  }
  return Object.freeze({
    async request<T>(path: string, options: { method?: Method; body?: unknown } = {}): Promise<T> {
      const method = options.method || 'GET';
      const url = validatePath(path, method);
      const write = method !== 'GET';
      if (!write && options.body !== undefined) invalidInput();
      let body: string | undefined;
      if (options.body !== undefined) {
        validateJson(options.body);
        body = JSON.stringify(options.body);
        if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) invalidInput();
      }
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ConnectorError(write ? 'CONNECTOR_OUTCOME_UNKNOWN' : 'PROVIDER_TIMEOUT',
            write ? 'The provider outcome is unknown. Reconcile before trying again.' : 'The connector provider timed out.', 504));
        }, COMPOSIO_TIMEOUT_MS);
      });
      try {
        const perform = async () => {
          const response = await fetch(url, {
            method, body, signal: controller.signal, redirect: 'error', cache: 'no-store', credentials: 'omit',
            headers: { 'x-api-key': apiKey, Accept: 'application/json', 'Content-Type': 'application/json' },
          });
          if (!response.ok) {
            // Only this documented 400/direct-execute case needs a body to distinguish
            // an account binding error. Other methods/statuses keep their HTTP-only path.
            if (response.status === 400 && method === 'POST' && /^\/tools\/execute\/[A-Z0-9_]+$/.test(path)) {
              let envelope: unknown;
              // The status is already authoritative. A broken or stalled OPTIONAL
              // diagnostic body must not supersede the known HTTP rejection.
              const bodyDeadline = AbortSignal.any([controller.signal, AbortSignal.timeout(250)]);
              try { envelope = await readJson(response, write, 4096, bodyDeadline); } catch { /* fall back to HTTP status */ }
              const failure = executionRequestFailure(envelope, response.status);
              if (failure) throw failure;
            }
            void response.body?.cancel().catch(() => undefined);
            httpError(response.status, write, response.headers.get('retry-after'));
          }
          return readJson(response, write);
        };
        return await Promise.race([perform(), timeout]) as T;
      } catch (error) {
        if (error instanceof ConnectorError) throw error;
        if (write) invalidProviderResponse(true);
        throw new ConnectorError('PROVIDER_UNAVAILABLE', 'The connector provider is unavailable.', 502);
      } finally {
        if (timer) clearTimeout(timer);
        controller.abort();
      }
    },
  });
}