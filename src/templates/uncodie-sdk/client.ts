/**
 * Uncodie Platform SDK — minimal fetch wrapper shipped into every generated
 * app under `src/lib/uncodie/`. It reads the API key from `UNCODIE_API_KEY`
 * and the base URL from `UNCODIE_API_BASE` (defaults to the Uncodie
 * production host) so the handlers from `src/lib/services/platform-api/`
 * can route every request to the right capability.
 */

export interface UncodieClientOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  defaultHeaders?: Record<string, string>;
  timeoutMs?: number;
}

export class UncodieApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.body = body;
    this.name = 'UncodieApiError';
  }
}

export class UncodieClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(options: UncodieClientOptions = {}) {
    const apiKey = options.apiKey ?? (typeof process !== 'undefined' ? process.env?.UNCODIE_API_KEY : undefined);
    if (!apiKey) {
      throw new Error('[uncodie] Missing UNCODIE_API_KEY — Platform SDK cannot authenticate.');
    }
    this.apiKey = apiKey;
    this.baseUrl = (
      options.baseUrl ??
      (typeof process !== 'undefined' ? process.env?.UNCODIE_API_BASE : undefined) ??
      'https://api.uncodie.com'
    ).replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.defaultHeaders = { 'Content-Type': 'application/json', ...(options.defaultHeaders ?? {}) };
    this.timeoutMs = options.timeoutMs ?? 15000;
  }

  async request<T = unknown>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}/api/platform/${path.replace(/^\//, '')}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...this.defaultHeaders,
          ...((init.headers as Record<string, string> | undefined) ?? {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        ...init,
      });
      const text = await res.text();
      const parsed = text ? safeJson(text) : null;
      if (!res.ok) {
        throw new UncodieApiError(res.status, parsed, `[uncodie] ${method} ${path} failed with ${res.status}`);
      }
      return parsed as T;
    } finally {
      clearTimeout(timer);
    }
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }
  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }
  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }
  delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
