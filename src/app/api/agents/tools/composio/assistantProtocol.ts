import { connectorGateway } from '@/lib/connectors/tool-resolver';
import type { ConnectorContextResolver } from '@/lib/connectors/host-context';

/** Legacy (siteId, apiKey) callers intentionally remain blocked: a credential
 * is not actor/agent/account authority. Never revive the old SDK adapter.
 */
export function composioActionTool(contextOrSite?: ConnectorContextResolver | string, options?: string | {accountPinned:boolean}) {
  return connectorGateway(typeof contextOrSite === 'function' ? contextOrSite : undefined,
    typeof contextOrSite === 'function' && typeof options === 'object' && options?.accountPinned===true);
}