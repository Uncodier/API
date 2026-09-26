import type {
  ConsoleSignal,
  ConsoleSignalEntry,
} from './step-iteration-signals';
import {
  HARNESS_TRACKING_SCRIPT_URL,
  LEGACY_TRACKING_SCRIPT_URL,
} from './tracking-script-contract';

export { HARNESS_TRACKING_SCRIPT_URL } from './tracking-script-contract';

export type HarnessTelemetryScope = {
  route: string;
  viewport: string;
};

// These are platform-owned tracking assets, not application dependencies. Match
// origin and path; the tracking script may carry a version/cache-busting query.
export const PLATFORM_TRACKING_SCRIPT_URLS = [
  HARNESS_TRACKING_SCRIPT_URL,
  LEGACY_TRACKING_SCRIPT_URL,
  'https://backend.makinari.com/tracking.min.js',
] as const;

export function isPlatformTrackingScriptUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return PLATFORM_TRACKING_SCRIPT_URLS.some((candidate) => {
      const known = new URL(candidate);
      return url.origin === known.origin &&
        url.pathname === known.pathname;
    });
  } catch {
    return false;
  }
}

function referencesExactHarnessTrackingScript(
  value: string | undefined,
): boolean {
  if (!value) return false;
  // Browser console locations append ":line" to the script URL.
  return isPlatformTrackingScriptUrl(value.replace(/:\d+(?::\d+)?$/, ''));
}

type FailedRequest = ConsoleSignal['failed_requests'][number];

function normalizeFailedRequestUrl(url: string): string {
  let normalizedUrl = url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete('_rsc');
    parsed.hash = '';
    normalizedUrl = parsed.toString();
  } catch {
    normalizedUrl = url
      .replace(/([?&])_rsc=[^&]*(&|$)/, (_match, prefix, suffix) =>
        suffix ? prefix : '',
      )
      .replace(/[?&]$/, '');
  }
  return normalizedUrl;
}

function failedRequestKey(
  request: ConsoleSignal['failed_requests'][number],
): string {
  return [
    request.route || '',
    request.viewport || '',
    request.resource_type || '',
    normalizeFailedRequestUrl(request.url),
  ].join('|');
}

function statusSeverity(status: number | undefined): number {
  if (status === undefined) return -1;
  if (status >= 500) return 4;
  if (status >= 400) return 3;
  if (status >= 300) return 2;
  return 1;
}

function mostSevereStatus(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  const leftRank = statusSeverity(left);
  const rightRank = statusSeverity(right);
  if (leftRank !== rightRank) return leftRank > rightRank ? left : right;
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}

function preservedFailure(
  left: string | undefined,
  right: string | undefined,
): string | undefined {
  if (!left) return right || undefined;
  if (!right) return left;
  return left.localeCompare(right) <= 0 ? left : right;
}

function normalizeFailedRequest(request: FailedRequest): FailedRequest {
  return {
    url: normalizeFailedRequestUrl(request.url),
    ...(request.status !== undefined ? { status: request.status } : {}),
    ...(request.failure ? { failure: request.failure } : {}),
    ...(request.resource_type ? { resource_type: request.resource_type } : {}),
    ...(request.route ? { route: request.route } : {}),
    ...(request.viewport ? { viewport: request.viewport } : {}),
  };
}

export function dedupeFailedRequests(
  requests: ConsoleSignal['failed_requests'],
): ConsoleSignal['failed_requests'] {
  const byRequest = new Map<string, FailedRequest>();
  for (const request of requests) {
    const key = failedRequestKey(request);
    const existing = byRequest.get(key);
    const normalized = normalizeFailedRequest(request);
    byRequest.set(
      key,
      existing
        ? {
            ...existing,
            status: mostSevereStatus(existing.status, normalized.status),
            failure: preservedFailure(existing.failure, normalized.failure),
          }
        : normalized,
    );
  }
  return Array.from(byRequest.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, request]) => normalizeFailedRequest(request));
}

/**
 * The workflow injects this telemetry script itself. Its availability is not
 * controlled by generated application code, so a DNS/CDN outage must not fail
 * the product gate. Match only known platform tracking script paths even if
 * application edits remove the ownership marker; keep all other failures.
 */
export function filterHarnessOwnedTelemetry(input: {
  entries: ConsoleSignalEntry[];
  pageErrors: ConsoleSignal['page_errors'];
  failedRequests: ConsoleSignal['failed_requests'];
  ownedScopes?: HarnessTelemetryScope[];
}): {
  entries: ConsoleSignalEntry[];
  pageErrors: ConsoleSignal['page_errors'];
  failedRequests: ConsoleSignal['failed_requests'];
} {
  return {
    entries: input.entries.filter(
      (entry) =>
        !referencesExactHarnessTrackingScript(entry.source) &&
        !referencesExactHarnessTrackingScript(entry.text),
    ),
    pageErrors: input.pageErrors.filter(
      (error) =>
        !referencesExactHarnessTrackingScript(error.message) &&
        !referencesExactHarnessTrackingScript(error.stack_tail),
    ),
    failedRequests: dedupeFailedRequests(
      input.failedRequests.filter(
        (request) => !referencesExactHarnessTrackingScript(request.url),
      ),
    ),
  };
}
