import type {
  ConsoleSignal,
  ConsoleSignalEntry,
} from './step-iteration-signals';
import { HARNESS_TRACKING_SCRIPT_URL } from './tracking-script-contract';

export { HARNESS_TRACKING_SCRIPT_URL } from './tracking-script-contract';

export type HarnessTelemetryScope = {
  route: string;
  viewport: string;
};

function referencesExactHarnessTrackingScript(
  value: string | undefined,
): boolean {
  return typeof value === 'string' && (
    value === HARNESS_TRACKING_SCRIPT_URL ||
    value.startsWith(`${HARNESS_TRACKING_SCRIPT_URL}:`)
  );
}

/**
 * The workflow injects this telemetry script itself. Its availability is not
 * controlled by generated application code, so a DNS/CDN outage must not fail
 * the product gate. Match the exact canonical URL even if application edits
 * remove the ownership marker; no other console or network failures are
 * suppressed.
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
    failedRequests: input.failedRequests.filter(
      (request) => !referencesExactHarnessTrackingScript(request.url),
    ),
  };
}
