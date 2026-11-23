import { CONNECTOR_REGISTRY_VERSION, getSkillDomains, getToolkitDomains } from './domains';
import type { ConnectorContextResolver } from './host-context';
import { modelAccountIdentity } from './model-account-identity';

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
    if (context.host !== 'assistant' || !context.agentId || !context.catalogUserSession) {
      return { ...base, status: 'unavailable', capabilities: [] };
    }
    const { listDirectAccounts } = await import('./provider-direct-policy');
    const { loadToolScreenAccess, canUseToolScreen } = await import('@/app/api/agents/tools/router/screen-access');
    const access = await loadToolScreenAccess(context);
    if (!access || !canUseToolScreen('connector_gateway', access)) return { ...base, status: 'unavailable', capabilities: [] };
    const connectors = await listDirectAccounts(context);
    // Skills supply account hints, not a second partial inventory or a claim that actions are reads.
    const capabilities = connectors.filter(({connector}) => getToolkitDomains(connector.toolkit_slug).some(domain=>domains.includes(domain)))
      .map(({connector})=>({...modelAccountIdentity(connector.id),tool_origin:'provider' as const,toolkit:connector.toolkit_slug,availability:'search_required',
        hint:'Search/list with tool_origin="provider" and this full connector_id. Ask which account if ambiguous.'}));
    return { ...base, status: 'available', capabilities: capabilities.slice(0, 5), truncated: capabilities.length > 5 };
  } catch { return { ...base, status: 'unavailable', capabilities: [] }; }
}