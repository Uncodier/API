import type {
  ConsoleSignal,
  ConsoleSignalEntry,
} from './step-iteration-signals';

export const HARNESS_TRACKING_SCRIPT_URL =
  'https://files.uncodie.com/tracking.min.js';

function referencesHarnessTrackingScript(value: string | undefined): boolean {
  return typeof value === 'string' && value.includes(HARNESS_TRACKING_SCRIPT_URL);
}

/**
 * The workflow injects this telemetry script itself. Its availability is not
 * controlled by generated application code, so a DNS/CDN outage must not fail
 * the product gate. No other console or network failures are suppressed.
 */
export function filterHarnessOwnedTelemetry(input: {
  entries: ConsoleSignalEntry[];
  pageErrors: ConsoleSignal['page_errors'];
  failedRequests: ConsoleSignal['failed_requests'];
}): {
  entries: ConsoleSignalEntry[];
  pageErrors: ConsoleSignal['page_errors'];
  failedRequests: ConsoleSignal['failed_requests'];
} {
  return {
    entries: input.entries.filter(
      (entry) =>
        !referencesHarnessTrackingScript(entry.source) &&
        !referencesHarnessTrackingScript(entry.text),
    ),
    pageErrors: input.pageErrors.filter(
      (error) =>
        !referencesHarnessTrackingScript(error.message) &&
        !referencesHarnessTrackingScript(error.stack_tail),
    ),
    failedRequests: input.failedRequests.filter(
      (request) => !referencesHarnessTrackingScript(request.url),
    ),
  };
}
