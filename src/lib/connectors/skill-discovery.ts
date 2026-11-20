import { scopesAllowed } from './action-policy';
import { CONNECTOR_REGISTRY_VERSION, getSkillDomains } from './domains';
import type { ConnectorContextResolver } from './host-context';
import { connectorToolRef, policyReviewedTools } from './reviewed-tools';

/** A separate bounded appendix, never a mutation of the versioned SKILL.md body.
 * Uses local grant metadata only. No provider catalog, schema, or session calls.
 */
export async function connectorSkillAppendix(slug: string, resolveContext?: ConnectorContextResolver) {
  const domains = getSkillDomains(slug).map(domain => domain.id);
  const base = { registry_version: CONNECTOR_REGISTRY_VERSION, domains,
    note: 'Discovery hints only. Follow the original skill scope. Describe exact tools before execution; current host and grants still apply.' };
  if (!resolveContext || !domains.length) return { ...base, status: 'unavailable', capabilities: [] };
  try {
    const context = await resolveContext();
    if (context.host === 'workflow' || (context.host === 'assistant' && !context.agentId)) {
      return { ...base, status: 'unavailable', capabilities: [] };
    }
    const { listUsableConnectors } = await import('./access');
    const { loadToolScreenAccess, canUseToolScreen } = await import('@/app/api/agents/tools/router/screen-access');
    const access = await loadToolScreenAccess(context);
    if (!access || !canUseToolScreen('connector_gateway', access)) return { ...base, status: 'unavailable', capabilities: [] };
    const connectors = await listUsableConnectors(context, !!context.instanceId && !!context.requestId);
    const capabilities = connectors.flatMap(authorized => policyReviewedTools(authorized.connector, authorized.policy)
      .filter(tool => scopesAllowed(authorized.connector, tool))
      .filter(tool => tool.domains.some(domain => domains.includes(domain)) &&
        (access.isAdmin || tool.requiredScreens.every(screen => !access.blockedScreens.includes(screen))))
      .map(tool => ({ name: connectorToolRef(authorized.connector.id, tool.slug), toolkit: tool.toolkit,
        availability: 'describe_required', effect: 'read', ...(authorized.requestOnly && {request_only: true}) })));
    return { ...base, status: 'available', capabilities: capabilities.slice(0, 5), truncated: capabilities.length > 5 };
  } catch { return { ...base, status: 'unavailable', capabilities: [] }; }
}