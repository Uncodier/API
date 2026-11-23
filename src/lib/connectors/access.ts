import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { withCatalogActorEvidence } from '@/lib/database/hosted-project-identity';
import { SUPABASE_CATALOG_SLUG } from './provider-report-action';
import { ConnectorError, isGrantCurrent, type AuthorizedConnector, type Connector, type ConnectorContext } from './types';
import { policyReviewedTools, REVIEWED_CONNECTOR_TOOLS } from './reviewed-tools';
import { effectiveAgentGrant, effectiveMemberGrant } from './grant-resolution';
import { connectorDatabaseError, requireConnectorSiteAccess, listVisibleConnectors, getVisibleConnector,
  loadConnectorCredential, getConnectorProvider, getConnectorPolicy, getMemberGrant } from './account-access';
export * from './account-access';

const uuid = z.string().uuid();
const deadline = () => AbortSignal.timeout(5_000);

// A provider descriptor and its current permissions must still be checked before dispatch.
// Never reinterpret a registered reviewed action (including one incompatible with this account).
function catalogSlug(slug: string) {
  return /^[A-Z0-9][A-Z0-9_]{0,149}$/.test(slug) && !slug.startsWith('COMPOSIO_')
    && !REVIEWED_CONNECTOR_TOOLS.some(tool => tool.slug === slug);
}

type CatalogActorCheck = () => Promise<{ allowed: boolean; localProjectRef: string | null }>;

// Only the instance path requests this extra authority. Share the actor lookup
// within one listing, never between requests or execution rechecks.
function catalogActorCheck(context: ConnectorContext, requested: boolean, proveProject = false): CatalogActorCheck | undefined {
  if (!requested || context.catalogUserSession !== true || context.host !== 'assistant' || !uuid.safeParse(context.instanceId).success || !uuid.safeParse(context.agentId).success) return;
  const read = async () => {
    const { data, error } = await supabaseAdmin.rpc('connector_catalog_read_actor', {
      p_site_id: context.siteId, p_user_id: context.userId, p_instance_id: context.instanceId, p_agent_id: context.agentId,
    }).abortSignal(deadline());
    // A real actor denial is a boolean false. A privilege failure executing this
    // server-only predicate is an infrastructure error, not a missing user or OAuth grant.
    if (error?.code === '42501') throw new ConnectorError('CATALOG_AUTHORIZATION_UNAVAILABLE', 'Connector authorization could not be evaluated.', 503);
    if (error || typeof data !== 'boolean') connectorDatabaseError(error);
    return data === true;
  };
  let check: ReturnType<CatalogActorCheck> | undefined;
  return () => check ??= proveProject ? withCatalogActorEvidence(read) : read().then(allowed => ({ allowed, localProjectRef: null }));
}

async function assertUse(context: ConnectorContext, connector: Connector, allowRequest: boolean, check?: CatalogActorCheck, action?: string): Promise<AuthorizedConnector> {
  // No delegation is inferred from a background run or an absent human principal.
  if (context.host !== 'assistant' && context.host !== 'direct') {
    throw new ConnectorError('HOST_DISABLED', 'Background connector delegation is not enabled.', 403);
  }
  if (context.host === 'assistant' && !context.agentId) {
    throw new ConnectorError('AGENT_REQUIRED', 'A verified agent identity is required for connector use.', 403);
  }
  const member = await getMemberGrant(context.siteId, context.userId, connector.id);
  const usable = effectiveMemberGrant(connector, member).can_use;
  // The SQL visibility boundary runs first (including manager visibility).
  // A persisted hidden/revoked/expired row is a veto even for a manager.
  if (!usable && (!allowRequest || (member !== null && (member.can_view !== true || member.can_use !== false || !isGrantCurrent(member))))) {
    throw new ConnectorError('ACCESS_DENIED', 'Connector use is not granted to this member.', 403);
  }
  const agentUse = context.agentId ? await requireConnectorAgent(connector, context.agentId, allowRequest) : true;
  const access = await resolveAccountPolicy(connector, context.host, usable && agentUse ? check : undefined,
    context.connectorIdHint === connector.id, action);
  if (usable && agentUse) return access;
  if (allowRequest && context.host === 'assistant' && context.agentId && access.policy.require_approval === true) {
    return { ...access, requestOnly: true };
  }
  throw new ConnectorError('ACCESS_DENIED', 'Connector action is unavailable.', 403);
}

export async function requireConnectorAgent(connector: Connector, agentId: string, allowAbsent = false) {
  uuid.parse(agentId);
  const { data, error } = await supabaseAdmin.from('connector_agents')
    .select('enabled,expires_at,revoked_at').eq('site_id', connector.site_id)
    .eq('connector_id', connector.id).eq('agent_id', agentId).abortSignal(deadline()).maybeSingle();
  if (error) connectorDatabaseError(error);
  const usable = effectiveAgentGrant(data);
  if (!usable && (!allowAbsent || data !== null)) throw new ConnectorError('ACCESS_DENIED', 'Connector use is not granted to this agent.', 403);
  const agent = await supabaseAdmin.from('agents').select('id').eq('id', agentId)
    .eq('site_id', connector.site_id).eq('status', 'active').abortSignal(deadline()).maybeSingle();
  if (agent.error) connectorDatabaseError(agent.error);
  if (!agent.data) throw new ConnectorError('ACCESS_DENIED', 'Agent is not available for this site.', 403);
  return usable;
}

/** Configuration and grant checks do not consume an approval or authorize dispatch. */
export function resolveConnectorPolicy(connector: Connector, host: string): Promise<AuthorizedConnector> {
  return resolveAccountPolicy(connector, host);
}

async function resolveAccountPolicy(connector: Connector, host: string, check?: CatalogActorCheck, selected = false, action?: string): Promise<AuthorizedConnector> {
  if (!connector.enabled || connector.revocation_pending || connector.provider_status !== 'ACTIVE') {
    throw new ConnectorError('AUTH_REQUIRED', 'This connector is disabled or requires authentication.', 409);
  }
  const policy = await getConnectorPolicy(connector.site_id, connector.id);
  const hostAllowed = policy.allowed_hosts.includes(host);
  const reviewed = policyReviewedTools(connector, policy).length > 0;
  const catalogScope = policy.tool_access_mode === 'all' || (action ? policy.allowed_tools.includes(action) : policy.allowed_tools.some(catalogSlug));
  // Never expose this setting for a guessed/unselected account or for an ineligible
  // principal. For discovery on mixed accounts keep returning the reviewed tools.
  const askForOptIn = selected && policy.catalog_reads === false && (action !== undefined || !reviewed);
  const actorCheck = check && (policy.catalog_reads === true || askForOptIn) && hostAllowed && catalogScope
    && connector.verified_at && !connector.revocation_dispatched ? await check() : null;
  const catalogEligible = actorCheck?.allowed === true;
  if (!hostAllowed || (!catalogEligible && !reviewed)) {
    throw new ConnectorError('ACCESS_DENIED', 'No tool policy permits this connector operation.', 403);
  }
  const provider = await getConnectorProvider(connector.site_id, connector.provider_id);
  const credential = await loadConnectorCredential(connector.site_id);
  if (!provider || provider.status !== 'active' || provider.credential_revision !== credential.revision) {
    throw new ConnectorError('PROVIDER_REVALIDATION_REQUIRED', 'Verify the provider configuration after changing its credential.', 409);
  }
  if (credential.source === 'byok') {
    const { readByokProviderBinding } = await import('./provider-attestations');
    const proof = await readByokProviderBinding(connector.site_id, credential.revision);
    if (proof.projectId !== provider.project_id || proof.projectId !== connector.provider_project_id) {
      throw new ConnectorError('PROVIDER_REVALIDATION_REQUIRED', 'Verify the existing provider project before using this connector.', 409);
    }
  }
  if (catalogEligible && askForOptIn) {
    throw new ConnectorError('CATALOG_OPT_IN_REQUIRED', 'Ask a workspace manager to enable catalogue reads for the selected connection.', 403);
  }
  return { connector, provider, ...(catalogEligible && actorCheck?.localProjectRef && { localProjectRef: actorCheck.localProjectRef }),
    policy: { ...policy, catalog_reads: catalogEligible && policy.catalog_reads === true } };
}

export async function listUsableConnectors(context: ConnectorContext, allowRequest = false, catalogReads = false): Promise<AuthorizedConnector[]> {
  const connectors = context.connectorIdHint === undefined ? await listVisibleConnectors(context.siteId, context.userId)
    : [await getVisibleConnector(context.siteId, context.userId, context.connectorIdHint)];
  const results: AuthorizedConnector[] = [];
  const check = catalogActorCheck(context, catalogReads);
  for (const connector of connectors) {
    try { results.push(await assertUse(context, connector, allowRequest, check)); }
    catch (error) {
      // This connector was already proven visible by getVisibleConnector. Explain failure for the
      // explicitly selected instance account, but never reveal hidden accounts in broad discovery.
      if (!(error instanceof ConnectorError) || error.status >= 500 || (catalogReads && context.connectorIdHint !== undefined && context.host === 'assistant' && context.instanceId)) throw error;
    }
  }
  return results;
}

export async function resolveConnectorAction(context: ConnectorContext, connectorId: string, toolSlug: string, allowRequest = false, catalogReads = false): Promise<AuthorizedConnector> {
  const access = await resolveAccount(context, connectorId, allowRequest,
    catalogActorCheck(context, catalogReads && catalogSlug(toolSlug), toolSlug === SUPABASE_CATALOG_SLUG), toolSlug);
  const catalogCandidate = !access.requestOnly && access.policy.catalog_reads === true && catalogSlug(toolSlug)
    && (access.policy.tool_access_mode === 'all' || access.policy.allowed_tools.includes(toolSlug));
  if (!catalogCandidate && !policyReviewedTools(access.connector, access.policy).some(tool => tool.slug === toolSlug)) {
    throw new ConnectorError('ACCESS_DENIED', 'This connector tool is not permitted.', 403);
  }
  return access;
}

/** Resolve account grants once for discovery. Concrete execution must still resolve the exact action. */
export function resolveUsableAccount(context: ConnectorContext, connectorId: string, allowRequest = false): Promise<AuthorizedConnector> {
  return resolveAccount(context, connectorId, allowRequest);
}

async function resolveAccount(context: ConnectorContext, connectorId: string, allowRequest: boolean, check?: CatalogActorCheck, action?: string): Promise<AuthorizedConnector> {
  if (context.connectorIdHint !== undefined && connectorId !== context.connectorIdHint) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found in the selected account.', 404);
  }
  const connector = await getVisibleConnector(context.siteId, context.userId, connectorId);
  return assertUse(context, connector, allowRequest, check, action);
}
/** Approval executes in the manager's own name on the original allowed host,
 * not with the proposer's agent grant. The caller independently rechecks origin. */
export async function resolveManagerAction(siteId: string, userId: string, id: string, slug: string) {
  await requireConnectorSiteAccess(siteId, userId, true);
  const connector = await getVisibleConnector(siteId, userId, id);
  if (!effectiveMemberGrant(connector, await getMemberGrant(siteId, userId, id)).can_use) {
    throw new ConnectorError('ACCESS_DENIED', 'Manager connector use is not granted.', 403);
  }
  const access = await resolveConnectorPolicy(connector, 'assistant');
  if (!policyReviewedTools(connector, access.policy).some(tool => tool.slug === slug)) {
    throw new ConnectorError('ACCESS_DENIED', 'This connector tool is not permitted.', 403);
  }
  return access;
}

export const authorizeConnectorExecution = (context: ConnectorContext, connectorId: string, toolSlug: string) =>
  resolveConnectorAction(context, connectorId, toolSlug);
