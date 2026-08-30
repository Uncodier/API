type FetchFn = typeof fetch;

/**
 * Next.js wraps global fetch. Vercel Workflow then passes an npm `undici.Agent`
 * as `dispatcher`. Node's built-in fetch uses a different undici copy, so
 * `Agent.dispatch` cannot read private field `#k` and the queue dies with
 * `TypeError: fetch failed`.
 *
 * Drop `dispatcher` so fetch uses the same undici instance it already owns.
 * Intercept later assignments: Next.js may replace `globalThis.fetch` after
 * instrumentation runs.
 */
export function installWorkflowSafeFetch(): void {
  const current = globalThis.fetch;
  if (!current || (current as FetchFn & { __workflowSafeFetch?: boolean }).__workflowSafeFetch) {
    return;
  }

  let inner: FetchFn = current;

  const safeFetch = ((input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
    if (init && typeof init === 'object' && 'dispatcher' in init) {
      const { dispatcher: _dispatcher, ...rest } = init as RequestInit & {
        dispatcher?: unknown;
      };
      return inner(input, rest);
    }
    return inner(input, init);
  }) as FetchFn & { __workflowSafeFetch?: boolean };

  safeFetch.__workflowSafeFetch = true;

  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    enumerable: true,
    get() {
      return safeFetch;
    },
    set(next: FetchFn) {
      if (next === safeFetch) return;
      if (typeof next === 'function') {
        inner = next;
      }
    },
  });
}
