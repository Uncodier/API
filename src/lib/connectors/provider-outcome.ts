import { ConnectorError } from './types';

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const httpStatus = (v: unknown): v is number => Number.isInteger(v) && Number(v) >= 400 && Number(v) <= 599;
type Operation = { effect: 'read' | 'unknown'; toolkit?: string };
const unknown = { effect: 'unknown' } as const;

function unconfirmed(operation: Operation): never {
  if (operation.effect === 'read') throw new ConnectorError('CONNECTOR_READ_FAILED', 'The read returned no verified result. Its cause is not confirmed.', 502);
  throw new ConnectorError('CONNECTOR_OUTCOME_UNKNOWN', 'The outcome is unconfirmed. Check the original system before trying again.', 502);
}

// POST is ambiguous to the transport. Only a caller that independently established
// read-only behavior can narrow this failure. Dispatch is never relabeled "not executed".
export function rethrowReadFailure(error: unknown): never {
  if (error instanceof ConnectorError && error.code !== 'CONNECTOR_OUTCOME_UNKNOWN') throw error;
  unconfirmed({ effect: 'read' });
}

function appFailure(status: number, operation: Operation, quota = false): never {
  if (status === 429 || quota) throw new ConnectorError('APP_RATE_LIMITED', 'The connected application rate limited this request.', 429);
  switch (status) {
    case 401: throw new ConnectorError('APP_AUTH_REJECTED', 'The connected application rejected authentication for this request.', 401);
    case 403: throw new ConnectorError('APP_RESOURCE_DENIED', 'The connected application denied this resource or operation.', 403);
    case 404: throw new ConnectorError('APP_RESOURCE_UNAVAILABLE', 'The requested resource is missing or not visible to this connection.', 404);
    default: {
      if (operation.effect === 'read' && (status === 408 || [500, 502, 503, 504].includes(status))) {
        throw new ConnectorError('APP_UNAVAILABLE', 'The connected application could not complete the read at this time.', 502);
      }
      return unconfirmed(operation);
    }
  }
}

/** v3.1 execute: a 200 with successful:false, error:string, data:object is a
 * failed action, not a platform credential rejection. The documented error may
 * be ONLY prose: neither it nor suggested fixes are parsed, logged or relayed.
 * https://docs.composio.dev/reference/api-reference/tools/postToolsExecuteByToolSlug */
export function assertProviderToolSucceeded(value: unknown, operation: Operation = unknown) {
  if (!object(value) || value.successful !== false) return; // caller independently validates success
  if (typeof value.error !== 'string' || !object(value.data)) unconfirmed(operation);
  const data = value.data;
  const status = data.status_code;
  // https://developers.google.com/workspace/calendar/api/guides/errors
  // A Google 403 may be a quota, not a denial. Require the documented structured
  // reason in the connected application's failed response, never string-match a message.
  if ((operation.toolkit === 'googlecalendar' || operation.toolkit === 'gmail') && object(data.error)) {
    const google = data.error;
    if (!httpStatus(google.code) || typeof google.message !== 'string' ||
      (status !== undefined && status !== google.code)) unconfirmed(operation);
    const reasons = google.errors;
    const quota = google.code === 403 && Array.isArray(reasons) && reasons.length > 0 && reasons.length <= 16 &&
      reasons.every(r => object(r) && r.domain === 'usageLimits' && typeof r.reason === 'string' && ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded'].includes(r.reason));
    appFailure(google.code, operation, quota);
  }
  if (httpStatus(status)) appFailure(status, operation);
  unconfirmed(operation);
}

/** The non-2xx REST envelope is about the platform's request, not an app's HTTP
 * status. Match the actual transport status AND the documented code+slug pair.
 * https://docs.composio.dev/docs/governance/action-permissions#error-codes */
export function executionRequestFailure(value: unknown, status: number): ConnectorError | undefined {
  if (status !== 400 || !object(value) || Object.hasOwn(value, 'successful') || !object(value.error)) return;
  const error = value.error;
  if (error.status !== status || error.code !== 1812 || error.slug !== 'ActionExecute_ConnectedAccountEntityIdMismatch' || typeof error.message !== 'string') return;
  return new ConnectorError('CONNECTOR_ACCOUNT_MISMATCH', 'The provider rejected the account binding for this request.', 409);
}
