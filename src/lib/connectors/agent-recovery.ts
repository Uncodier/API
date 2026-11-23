import { ConnectorError, ConnectorInputGuidance } from './types';
import { ConnectorArgumentError } from './connector-argument-error';
import { argumentFailure } from '@/lib/tools/argument-contract';
import type { ToolArgumentIssue } from '@/lib/tools/argument-contract';

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
    case 'PROVIDER_DIRECT_NOT_ENABLED': case 'DIRECT_POLICY_REQUIRED':
      return advice('ask_manager', 'Makinari did not authorize this connection or tool for this Ask turn. A manager can check Ask availability and the saved member, agent and tool permissions in Connectors. This is not a rejection from the provider. Do not reconnect, request a broader token or switch accounts.');
    case 'ASK_SHARED_DATABASE':
      return advice('alternate_route', 'This connection points to the shared Makinari database. Ask cannot query it as an external account. Selecting all tools or reconnecting will not change that. For these KPIs, ask for a read-only source containing only the authorized metrics. Do not request an admin token, substitute a different scope or report any figures as if a query had run.');
    case 'DIRECT_DISPATCH_ALREADY_CLAIMED':
      return advice('reconcile', 'This request already reserved the provider action. Check its private receipt or the connected application; do not dispatch it again.');
    case 'DIRECT_DISPATCH_UNCONFIRMED':
      return advice('reconcile', 'The reservation could not be confirmed. Do not resubmit or change arguments; check the status of the original request.');
    case 'DIRECT_POLICY_UNAVAILABLE':
      return advice('retry_later', 'The account policy service is unavailable. Do not change credentials, switch connections or treat the failure as missing data.');
    case 'DIRECT_RESULT_UNCONFIRMED':
      return advice('reconcile', 'The provider action was sent but a private result could not be released. Check private results or the selected account. Do not repeat the action.');
    case 'CATALOG_SELECTION_CHANGED': return advice('ask_manager', 'Some saved actions are no longer in the current provider catalog. Ask a manager to refresh the selection; other returned actions are unaffected.');
    case 'NOT_FOUND': case 'APP_RESOURCE_UNAVAILABLE': case 'PROVIDER_NOT_FOUND':
      return advice('ask_user', 'Ask the user to verify the intended connection or resource. Missing and not visible may look identical.', manual);
    case 'SCOPES_REQUIRED': case 'CONNECTOR_SCOPE_MISSING':
      return advice('request_scope', 'Ask the connection owner to verify the required permission and reauthorize in Connectors if it is missing. Never ask for credentials in chat.', manual);
    case 'AUTH_REQUIRED': case 'APP_AUTH_REJECTED': case 'CONNECTOR_NOT_ACTIVE': case 'CONNECTOR_NOT_READY':
      return advice('verify_connection', 'Ask the owner to check that the selected connection is active and reconnect it in Connectors if needed.', manual);
    case 'CONNECTOR_PROJECT_UNBOUND': case 'CONNECTOR_ACCOUNT_MISMATCH': case 'STALE_CREDENTIAL':
      return advice('verify_connection', 'Ask a manager to verify the exact connected account or project in Connectors. Do not substitute another account.', manual);
    case 'PROVIDER_SETUP_REQUIRED': case 'PROVIDER_PROJECT_CHANGED': case 'PROVIDER_REVALIDATION_REQUIRED': case 'COMPOSIO_PROJECT_SETUP_REQUIRED':
      return advice('ask_manager', 'Ask the platform operator to verify the Composio project, current credential binding and callback configuration used by this workspace. This is not a permission request to the connected app. Do not reconnect it or ask for credentials.', manual);
    case 'NOT_CONFIGURED': case 'CREDENTIAL_UNAVAILABLE': case 'PROVIDER_AUTH_FAILED':
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
    case 'ANALYTICS_WORKSPACE_ONLY':
      return advice('ask_user', 'This external dataset is authorized only for the workspace. Ask whether a clearly labeled workspace report is useful or request an authorized all-account export. Do not substitute scopes silently.',manual);
    case 'ANALYTICS_WORKSPACE_DENIED':
      return advice('ask_manager', 'Ask the workspace manager to verify this source and the current actor, agent and connector-use permissions. Procurement sources require unrestricted owner or admin access. No new provider token or platform grant is required for workspace scope.',manual);
    case 'ANALYTICS_SCOPE_DENIED':
      return advice('ask_manager', 'The requested source or all-account scope has not been authorized for this actor and connection. Ask the platform operator to verify the exact analytics grant and access to the requested source (procurement also requires a workspace manager). Do not reconnect or substitute workspace totals.',manual);
    case 'SUPABASE_DATASET_UNAVAILABLE': case 'ANALYTICS_SOURCE_UNVERIFIED':
      return advice('alternate_route', 'This project or analytics source could not be verified for direct reads. Ask the project operator to configure its dataset and reporting-role permissions. Do not infer a zero total.',manual);
    case 'CATALOG_AUTHORIZATION_UNAVAILABLE':
      return advice('retry_later', 'Makinari could not verify connector access. Do not reconnect or change workspace permissions; contact Makinari support if this persists.', manual);
    case 'PROVIDER_TIMEOUT': case 'PROVIDER_UNAVAILABLE': case 'STORAGE_UNAVAILABLE': case 'HOST_IDENTITY_UNAVAILABLE': case 'TOOL_SCREEN_ACCESS_UNAVAILABLE':
      return advice('retry_later', 'A verification service is unavailable. This does not establish missing permissions. Offer to retry later.', manual);
    case 'DIRECT_ACTION_UNSUPPORTED': case 'TOOL_UNREVIEWED': case 'SCHEMA_UNSUPPORTED': case 'SCOPES_UNSUPPORTED': case 'CONNECTOR_SCOPE_UNSUPPORTED': case 'CONNECTOR_UNSAFE_ARGUMENT':
      return advice('alternate_route', 'This operation cannot be verified for automatic execution. Offer the user a manual step or request the authorized result instead.', manual);
    default: return advice('ask_user', 'Explain that the connector did not return a usable result. Do not claim missing permissions or retry automatically.', manual);
  }
}

type AgentFailure = {success:false; code:string; error:string; recovery:Advice; automatic_retry:false;
  executed?:false; effectStarted?:false; retry_after_seconds?:number; argument_issue?:ToolArgumentIssue};
export function failureForAgent(error: unknown): AgentFailure {
  const e = error as {code?: unknown; name?: unknown; effectStarted?: unknown; retryAfterSeconds?: unknown} | undefined;
  if (e?.name === 'RecoveryError' || e?.name === 'OpenRouterBillingError') throw error;
  if (error instanceof ConnectorArgumentError && e?.effectStarted === false) return argumentFailure(error.issue);
  const code = error instanceof ConnectorError && /^[A-Z][A-Z_0-9]{0,70}$/.test(error.code) ? error.code :
    e?.code === 'TOOL_SCREEN_ACCESS_DENIED' || e?.code === 'TOOL_SCREEN_ACCESS_UNAVAILABLE' ? e.code : 'CONNECTOR_UNAVAILABLE';
  let recovery = error instanceof ConnectorInputGuidance && e?.effectStarted === false
    ? advice('fix_arguments', `${error.correction} Correct the input on the same connection and scope; do not repeat it unchanged.`)
    : agentRecovery(code);
  if ((code === 'INVALID_TOOL_ARGUMENTS' || code === 'CONNECTOR_INVALID_INPUT') && e?.effectStarted !== false) {
    recovery = advice('reconcile', 'The operation was not confirmed as rejected before execution. Check its status before issuing another call; do not replay it based on an argument error.');
  }
  const retryAfter = e?.retryAfterSeconds;
  // Use local guidance, never raw upstream text, arguments, customer IDs or credential material.
  return { success: false, code, error: recovery.message, recovery,
    ...(code === 'PROVIDER_RATE_LIMITED' && typeof retryAfter === 'number' && Number.isInteger(retryAfter) && retryAfter >= 0 && retryAfter <= 86_400 ? { retry_after_seconds: retryAfter } : {}),
    ...(e?.effectStarted === false ? { executed: false, effectStarted: false } : {}), automatic_retry: false };
}
