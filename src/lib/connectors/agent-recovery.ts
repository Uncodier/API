import { ConnectorError } from './types';

type Action = 'ask_manager' | 'ask_user' | 'verify_connection' | 'request_scope' | 'alternate_route' |
  'retry_later' | 'describe_again' | 'restart_search' | 'fix_arguments' | 'reconcile';
type Advice = { action: Action; message: string; alternative?: string };
const manual = 'Offer user-provided data or a native tool only if it is independently authorized for the same data and task. Do not switch accounts or credentials to bypass a denial.';
const advice = (action: Action, message: string, alternative?: string): Advice => ({ action, message, ...(alternative && { alternative }) });
export function agentRecovery(code: string): Advice {
  switch (code) {
    case 'HOST_DISABLED': case 'AGENT_REQUIRED': case 'ACCESS_DENIED': case 'CONNECTOR_TOOL_DENIED': case 'TOOL_SCREEN_ACCESS_DENIED':
      return advice('ask_manager', 'Ask a workspace manager to check the member, agent and tool policy in Connectors. Do not request a token in chat.', manual);
    case 'CATALOG_READS_DISABLED': case 'CATALOG_OPT_IN_REQUIRED':
      return advice('ask_manager', 'Ask a workspace manager to enable catalog reads for this connection in Connectors if appropriate.', manual);
    case 'CATALOG_SELECTION_CHANGED': return advice('ask_manager', 'Some saved actions are no longer in the current provider catalog. Ask a manager to refresh the selection; other returned actions are unaffected.');
    case 'NOT_FOUND': case 'APP_RESOURCE_UNAVAILABLE': case 'PROVIDER_NOT_FOUND':
      return advice('ask_user', 'Ask the user to verify the intended connection or resource. Missing and not visible may look identical.', manual);
    case 'SCOPES_REQUIRED': case 'CONNECTOR_SCOPE_MISSING':
      return advice('request_scope', 'Ask the connection owner to verify the required permission and reauthorize in Connectors if it is missing. Never ask for credentials in chat.', manual);
    case 'AUTH_REQUIRED': case 'APP_AUTH_REJECTED': case 'CONNECTOR_NOT_ACTIVE': case 'CONNECTOR_NOT_READY':
      return advice('verify_connection', 'Ask the owner to check that the selected connection is active and reconnect it in Connectors if needed.', manual);
    case 'CONNECTOR_PROJECT_UNBOUND': case 'CONNECTOR_ACCOUNT_MISMATCH': case 'PROVIDER_PROJECT_CHANGED': case 'PROVIDER_REVALIDATION_REQUIRED': case 'STALE_CREDENTIAL':
      return advice('verify_connection', 'Ask a manager to verify the exact connected account or project in Connectors. Do not substitute another account.', manual);
    case 'CREDENTIAL_UNAVAILABLE': case 'PROVIDER_AUTH_FAILED': case 'PROVIDER_SETUP_REQUIRED': case 'COMPOSIO_PROJECT_SETUP_REQUIRED':
      return advice('ask_manager', 'Ask a manager to verify the workspace Composio configuration. This is not proof the connected app token expired.', manual);
    case 'APP_RESOURCE_DENIED': case 'PROVIDER_FORBIDDEN':
      return advice('ask_user', 'Ask the owner to verify access to this specific resource and operation. Do not mark every action on the connection as denied.', manual);
    case 'APP_UNAVAILABLE': return advice('retry_later', 'The connected application was unavailable for this read. Offer to try later or ask for the authorized result instead; do not retry automatically.', manual);
    case 'APP_RATE_LIMITED': case 'PROVIDER_RATE_LIMITED':
      return advice('retry_later', 'Explain that a request quota was reached, not a permission failure. Wait; do not retry in a loop.', manual);
    case 'ACCESS_CHANGED':
      return advice('ask_user', 'Access changed before the result could be released. Ask the user to verify access before starting a new request.', manual);
    case 'STALE_CURSOR': return advice('restart_search', 'Repeat the search without the previous cursor.');
    case 'CONNECTOR_SCHEMA_CHANGED': case 'SCHEMA_CHANGED': case 'DESCRIBE_REQUIRED':
      return advice('describe_again', 'Describe the exact tool again and use its current version and schema. Do not replay a previous call.');
    case 'INVALID_TOOL_ARGUMENTS': case 'CONNECTOR_INVALID_INPUT': case 'INVALID_FILTER': case 'INVALID_TOOL_REFERENCE':
      return advice('fix_arguments', 'Use the arguments and reference returned by tools search and describe. Ask the user only for missing non-secret inputs.');
    case 'PRIVATE_DESTINATION_REQUIRED':
      return advice('ask_user', 'Ask the user to start a direct interactive Robots turn from their signed-in account. Do not use an API key, background task or recovered turn to receive private data.');
    case 'PRIVATE_DELIVERY_UNCONFIRMED':
      return advice('reconcile', 'The connector was read but delivery could not be confirmed. Ask the user to check Connectors → Private reports before requesting another read. Do not repeat the call automatically or infer a result.');
    case 'CONNECTOR_RESULT_UNSUPPORTED':
      return advice('alternate_route', 'The provider was called, but the result is not safe or supported for display. Ask the user for a limited export instead of replaying the call.', manual);
    case 'CONNECTOR_READ_FAILED':
      return advice('alternate_route', 'The read did not return a verified result. Do not infer missing access, an empty dataset, or a zero total. Ask for a limited export or a manual check.', manual);
    case 'CONNECTOR_OUTCOME_UNKNOWN':
      return advice('reconcile', 'Tell the user no result was confirmed. Verify the outcome in the original system before repeating this operation or attempting it another way.');
    case 'PROVIDER_TIMEOUT': case 'PROVIDER_UNAVAILABLE': case 'STORAGE_UNAVAILABLE': case 'HOST_IDENTITY_UNAVAILABLE': case 'TOOL_SCREEN_ACCESS_UNAVAILABLE':
      return advice('retry_later', 'A verification service is unavailable. This does not establish missing permissions. Offer to retry later.', manual);
    case 'TOOL_UNREVIEWED': case 'SCHEMA_UNSUPPORTED': case 'SCOPES_UNSUPPORTED': case 'CONNECTOR_SCOPE_UNSUPPORTED': case 'CONNECTOR_UNSAFE_ARGUMENT':
      return advice('alternate_route', 'This operation cannot be verified for automatic execution. Offer the user a manual step or request the authorized result instead.', manual);
    default: return advice('ask_user', 'Explain that the connector did not return a usable result. Do not claim missing permissions or retry automatically.', manual);
  }
}

export function failureForAgent(error: unknown) {
  const e = error as {code?: unknown; name?: unknown; effectStarted?: unknown; retryAfterSeconds?: unknown} | undefined;
  if (e?.name === 'RecoveryError' || e?.name === 'OpenRouterBillingError') throw error;
  const code = error instanceof ConnectorError && /^[A-Z][A-Z_0-9]{0,70}$/.test(error.code) ? error.code :
    e?.code === 'TOOL_SCREEN_ACCESS_DENIED' || e?.code === 'TOOL_SCREEN_ACCESS_UNAVAILABLE' ? e.code : 'CONNECTOR_UNAVAILABLE';
  const recovery = agentRecovery(code);
  const retryAfter = e?.retryAfterSeconds;
  // Use local guidance, never raw upstream text, arguments, customer IDs or credential material.
  return { success: false, code, error: recovery.message, recovery,
    ...(code === 'PROVIDER_RATE_LIMITED' && typeof retryAfter === 'number' && Number.isInteger(retryAfter) && retryAfter >= 0 && retryAfter <= 86_400 ? { retry_after_seconds: retryAfter } : {}),
    ...(e?.effectStarted === false ? { executed: false, effectStarted: false } : {}), automatic_retry: false };
}
