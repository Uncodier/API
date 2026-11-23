import type { RoutedTool } from '@/app/api/agents/tools/router/assistantProtocol';
import { assertToolScreenAccess, type ToolScreenScope } from '@/app/api/agents/tools/router/screen-access';
import { ConnectorError } from './types';
import type { ConnectorContextResolver } from './host-context';
import type { ProviderDirectRuntime } from './provider-direct-runtime';
import { CONNECTOR_DOMAINS } from './domains';
import { agentRecovery, failureForAgent } from './agent-recovery';
import { argumentFailure } from '@/lib/tools/argument-contract';

/** A spread-safe host-private marker. A matching name/prefix alone grants nothing. */
export const CONNECTOR_GATEWAY = Symbol.for('makinari.connector-gateway');
type Gateway = RoutedTool & { [CONNECTOR_GATEWAY]?: true };

export const connectorFailure = failureForAgent;
const catalogQuery = { type: 'string', description: 'English tool keywords or an exact tool slug for local catalog matching; use short public action terms. Never include customer text, names, credentials, query literals or other private values.' };

/** Lazy construction: merely building a host/skill catalog never loads a secret or schema. */
export function connectorGateway(resolveContext?: ConnectorContextResolver): Gateway {
  let runtime: Promise<ProviderDirectRuntime> | undefined;
  const getRuntime = async () => {
    if (!resolveContext) throw new ConnectorError('HOST_DISABLED', 'This host has no verified connector binding.', 403);
    runtime ??= import('./provider-direct-runtime').then(module => module.createProviderDirectRuntime(resolveContext));
    return runtime;
  };
  return {
    [CONNECTOR_GATEWAY]: true,
    name: 'use_composio_tools',
    description: 'Compatibility facade for tools connector discovery. Prefer tools search/describe/call. Exact connector references and fresh grants are required; no implicit account selection.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['search', 'describe', 'execute'] },
      search_intent: { type: 'string' }, catalog_query: catalogQuery, action_name: { type: 'string', description: 'Exact connector:<id>:<tool> reference.' },
      action_params: { type: 'string', description: 'JSON-encoded arguments from the described schema.' },
      domain: { type: 'string' }, category: { type: 'string' },
      connector_id: { type: 'string' }, connector_cursor: { type: 'string' },
    }, required: ['action'] },
    execute: async (args: any) => {
      try {
        const resolver = await getRuntime();
        if (args.action === 'search') return { success: true, ...await resolver.search({ query: args.search_intent,
          catalog_query: args.catalog_query, domain: args.domain, category: args.category, connector_id: args.connector_id, cursor: args.connector_cursor }) };
        if (args.action === 'describe') return { success: true, ...await resolver.describe(args.action_name ?? '') };
        if (args.action === 'execute') {
          let input = args.action_params ?? {};
          if (typeof input === 'string') {
            if (input.length > 32_000) return argumentFailure({path:'arguments',rule:'bounded'});
            try { input = JSON.parse(input); } catch { return argumentFailure({path:'arguments',rule:'json_object'}); }
          }
          return await resolver.call(args.action_name ?? '', input);
        }
        throw new ConnectorError('INVALID_ACTION', 'Use search, describe or execute.', 400);
      } catch (error) { return connectorFailure(error); }
    },
  };
}

/** Invoke the actual decorated gateway, not a detached resolver closure. Host filtering,
 * dry-run, recovery and billing wrappers therefore apply to concrete references too.
 */
export function withConnectorResolver(native: RoutedTool, tools: RoutedTool[], scope?: ToolScreenScope): RoutedTool {
  const gateways = tools.filter(tool => tool.name === 'use_composio_tools' && (tool as Gateway)[CONNECTOR_GATEWAY]);
  const gateway = gateways.length === 1 ? gateways[0] : undefined;
  const invoke = async (args: any) => {
    if (!gateway) return connectorFailure(Object.assign(new ConnectorError('HOST_DISABLED', 'Connector unavailable.', 403), { effectStarted: false }));
    try {
      await assertToolScreenAccess('connector_gateway', scope);
    } catch (error) { return { ...connectorFailure(error), executed: false, effectStarted: false }; }
    try { return await gateway.execute(args); }
    catch (error) { return connectorFailure(error); }
  };
  return { ...native, parameters: { ...native.parameters, properties: { ...native.parameters.properties,
    domain: { type: 'string', description: 'Optional connector business-domain filter. Classification is not a permission.' },
    connector_id: { type: 'string', description: 'Search or list only this exact local connector account, without native Makinari tools. Current grants still apply.' },
    catalog_query: catalogQuery,
    connector_cursor: { type: 'string', description: 'Continuation returned as connector_next_cursor; retain the same search filters.' },
  } }, execute: async (args: any) => {
    if ((args.action === 'call' || args.action === 'describe') && typeof args.name === 'string' && args.name.startsWith('connector:')) {
      return invoke({ action: args.action === 'call' ? 'execute' : 'describe', action_name: args.name,
        action_params: args.args, thought_process: args.thought_process });
    }
    if (!['search', 'list'].includes(args.action)) return native.execute(args);
    const accountOnly = args.connector_id !== undefined;
    if (accountOnly && args.action === 'search' && (typeof args.query !== 'string' || !args.query.trim())) {
      return { success: false, error: 'Provide a search query, or use list to browse this account.' };
    }
    // An explicit external search must not substitute the local report tool, even on an outage.
    const result = accountOnly ? { success: true, tools: [] } : await native.execute(args);
    if ((!gateway && !accountOnly) || result?.success === false) return result;
    const external = await invoke({ action: 'search', search_intent: args.action === 'search' ? args.query : undefined,
      domain: args.domain, category: args.category, connector_id: args.connector_id,
      catalog_query: args.catalog_query, connector_cursor: args.connector_cursor, thought_process: args.thought_process });
    const compatibleCategories = args.domain ? CONNECTOR_DOMAINS.find(domain => domain.id === args.domain)?.categories ?? [] : null;
    const nativeTools = (result.tools ?? []).filter((tool: any) => tool.name !== gateway?.name &&
      (!args.category || tool.category === args.category) && (!compatibleCategories || compatibleCategories.includes(tool.category)));
    const connectorTools = external.success ? external.tools ?? [] : [];
    const failure = external.success ? external.partial_error : external.code ?? 'CONNECTOR_UNAVAILABLE';
    const hint = failure ? agentRecovery(failure).message : !connectorTools.length && !external.next_cursor
      ? accountOnly ? 'No eligible match on this connection. Do not substitute a native report or another account.'
        : 'No matching provider tool was found on a connection available to Ask. This is not a query result or proof of missing provider permissions.'
      : 'Continue with connector_next_cursor even if this page is empty. Describe the exact account reference before calling; a catalog match is not execution authority.';
    const merged = [...nativeTools.slice(0, args.action === 'search' ? 10 - connectorTools.length : nativeTools.length), ...connectorTools];
    return { ...result, ...(accountOnly && !external.success && { success: false }), tools: merged, count: merged.length,
      connector_status: external.success ? (failure ? 'partial' : 'available') : 'unavailable',
      ...(failure ? { connector_error: failure, connector_recovery: agentRecovery(failure) } : {}),
      connector_next_cursor: external.success ? external.next_cursor ?? null : null,
      truncated: external.truncated || (args.action === 'search' && nativeTools.length + connectorTools.length > 10),
      hint };
  } };
}