import { memberSupportScope, type SupportConnectorScope } from './support-runtime-contract';
import { optionalGenericSupport } from './support-generic-authority';
import { searchDirectTools } from './provider-direct-discovery';
import type { DirectAuthorizedConnector } from './provider-direct-policy';
import { ConnectorError } from './types';

type Member = Extract<SupportConnectorScope, { audience: 'member' }>;
export async function memberDiscoveryTargets(scope: Member, ids: string[]) {
  scope = memberSupportScope.parse(scope);
  const eligible = await Promise.all(ids.map(async id => {
    try {
      const access = await optionalGenericSupport(scope, id);
      if (!access) return null;
      const { target } = access;
      if (target.requestOnly || target.connector.id !== id || target.connector.site_id !== scope.siteId) return null;
      if (target.policy.tool_access_mode !== 'all' && !target.policy.allowed_tools.length) return null;
      return target;
    } catch (error) {
      if (error instanceof ConnectorError && [403,404,409].includes(error.status)) return null;
      throw error;
    }
  }));
  return eligible.filter((t): t is DirectAuthorizedConnector => t !== null);
}

export async function memberToolPage(scope: Member, filter: { query?: string; connector_id?: string }, targets: DirectAuthorizedConnector[], cursor?: string) {
  scope = memberSupportScope.parse(scope);
  const page = await searchDirectTools({ siteId: scope.siteId, agentId: scope.agentId, userId: scope.userId, host: 'assistant' },
    { query: filter.query, connector_id: filter.connector_id, cursor }, targets);
  // A failed provider lookup is not an empty page or permission to try the next account.
  if (page.partial_error) throw new ConnectorError('SUPPORT_UNAVAILABLE', 'Support catalog unavailable.', 503);
  const tools = page.tools.map(({ name, toolkit, connector_id, description, availability, account_label }) => ({ name, toolkit, connector_id, description, availability, account_label }));
  return { tools, next_cursor: page.next_cursor };
}
