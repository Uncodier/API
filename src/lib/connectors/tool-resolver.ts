import type { RoutedTool } from '@/app/api/agents/tools/router/assistantProtocol';
import { assertToolScreenAccess, type ToolScreenScope } from '@/app/api/agents/tools/router/screen-access';
import { ConnectorError } from './types';
import type { ConnectorContextResolver } from './host-context';
import type { ProviderDirectRuntime } from './provider-direct-runtime';
import { CONNECTOR_DOMAINS } from './domains';
import { agentRecovery, failureForAgent } from './agent-recovery';
import { argumentFailure } from '@/lib/tools/argument-contract';
import { parseConnectorToolRef, retiredReportRef } from './connector-ref';

/** A spread-safe host-private marker. A matching name/prefix alone grants nothing. */
export const CONNECTOR_GATEWAY = Symbol.for('makinari.connector-gateway');
const PINNED_ACCOUNT = Symbol.for('makinari.connector-gateway.pinned-account');
type Gateway = RoutedTool & { [CONNECTOR_GATEWAY]?: true; [PINNED_ACCOUNT]?: true };

export const connectorFailure = failureForAgent;
const catalogQuery = { type: 'string', description: 'English tool keywords or an exact tool slug for local catalog matching; use short public action terms. Never include customer text, names, credentials, query literals or other private values.' };
const originFilter = {type:'string',enum:['provider'],description:'Search/list only this tool origin. Use provider for a connected application. Never change origins to work around a denial.'};
// Handle stale clients before invoking a decorated gateway or the native router.
export function retiredConnectorTarget(args: { tool_origin?: unknown; name?: unknown; query?: unknown; catalog_query?: unknown }) {
  return (args.tool_origin !== undefined && args.tool_origin !== 'provider') ||
    retiredReportRef(args.name) || retiredReportRef(args.query) || retiredReportRef(args.catalog_query);
}
const unavailableTarget = () => ({ success: false, code: 'INVALID_TOOL_REFERENCE', error: 'This connector target is unavailable. Do not substitute another tool or account.', tools: [], executed: false, effectStarted: false, automatic_retry: false });
function checkReference(name:string,origin:unknown,account:unknown) {
  const ref=parseConnectorToolRef(name);
  if(origin!==undefined && origin!=='provider')throw new ConnectorError('INVALID_TOOL_REFERENCE','The reference does not match the requested tool origin.',400);
  if(account!==undefined && account!==ref.connectorId)throw new ConnectorError('NOT_FOUND','The reference does not belong to the requested account.',404);
}

/** Lazy construction: merely building a host/skill catalog never loads a secret or schema. */
export function connectorGateway(resolveContext?: ConnectorContextResolver,accountPinned=false): Gateway {
  let runtime: Promise<ProviderDirectRuntime> | undefined;
  const getRuntime = async () => {
    if (!resolveContext) throw new ConnectorError('HOST_DISABLED', 'This host has no verified connector binding.', 403);
    runtime ??= import('./provider-direct-runtime').then(module => module.createProviderDirectRuntime(resolveContext));
    return runtime;
  };
  return {
    [CONNECTOR_GATEWAY]: true,
    ...(accountPinned && {[PINNED_ACCOUNT]:true as const}),
    name: 'use_composio_tools',
    description: 'Compatibility facade for tools connector discovery. Prefer tools search/describe/call. Exact connector references and fresh grants are required; no implicit account selection.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['search', 'describe', 'execute'] },
      search_intent: { type: 'string' }, catalog_query: catalogQuery, tool_origin:originFilter, action_name: { type: 'string', description: 'Exact reference from discovery: connector:<id>:<provider action>.' },
      action_params: { type: 'string', description: 'JSON-encoded arguments from the described schema.' },
      domain: { type: 'string' }, category: { type: 'string' },
      connector_id: { type: 'string' }, connector_cursor: { type: 'string' },
    }, required: ['action'] },
    execute: async (args: any) => {
      try {
        if (retiredConnectorTarget({name: args.action_name, query: args.search_intent, catalog_query: args.catalog_query, tool_origin: args.tool_origin})) return unavailableTarget();
        const resolver = await getRuntime();
        if (args.action === 'search') return { success: true, ...await resolver.search({ query: args.search_intent,
          catalog_query: args.catalog_query, domain: args.domain, category: args.category, connector_id: args.connector_id, cursor: args.connector_cursor, tool_origin: args.tool_origin }) };
        if(args.action==='describe'||args.action==='execute') {
          try {checkReference(args.action_name,args.tool_origin,args.connector_id);} catch(error) {
            return {...connectorFailure(error),executed:false,effectStarted:false};
          }
        }
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
  const accountPinned=(gateway as Gateway|undefined)?.[PINNED_ACCOUNT]===true;
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
    connector_id: { type: 'string', description: 'The exact local account ID. Copy it from the selection. Do not guess an account or select a similar tool from another one.' },
    tool_origin:originFilter,
    catalog_query: catalogQuery,
    connector_cursor: { type: 'string', description: 'Continuation returned as connector_next_cursor; retain the same search filters.' },
  } }, execute: async (args: any) => {
    if (retiredConnectorTarget(args)) return unavailableTarget();
    const qualified=typeof args.name==='string' && args.name.startsWith('connector:');
    if ((args.action === 'call' || args.action === 'describe') && (qualified || args.tool_origin!==undefined || args.connector_id!==undefined || (accountPinned && args.name==='report'))) {
      return invoke({ action: args.action === 'call' ? 'execute' : 'describe', action_name: args.name,
        action_params: args.args, thought_process: args.thought_process,tool_origin:args.tool_origin,connector_id:args.connector_id });
    }
    if (!['search', 'list'].includes(args.action)) return native.execute(args);
    // A server-pinned account still narrows discovery if the model omits connector_id.
    // This marker only suppresses native results; runtime policy binds and authorizes the actual ID.
    const accountOnly = args.connector_id !== undefined || args.tool_origin!==undefined || accountPinned;
    if (accountOnly && args.action === 'search' && (typeof args.query !== 'string' || !args.query.trim())) {
      return { success: false, error: 'Provide a search query, or use list to browse this account.' };
    }
    // An explicit external search must not substitute the local report tool, even on an outage.
    const result = accountOnly ? { success: true, tools: [] } : await native.execute(args);
    if ((!gateway && !accountOnly) || result?.success === false) return result;
    const external = await invoke({ action: 'search', search_intent: args.action === 'search' ? args.query : undefined,
      domain: args.domain, category: args.category, connector_id: args.connector_id,
      catalog_query: args.catalog_query, connector_cursor: args.connector_cursor, tool_origin:args.tool_origin, thought_process: args.thought_process });
    const compatibleCategories = args.domain ? CONNECTOR_DOMAINS.find(domain => domain.id === args.domain)?.categories ?? [] : null;
    const nativeTools = (result.tools ?? []).filter((tool: any) => tool.name !== gateway?.name &&
      (!args.category || tool.category === args.category) && (!compatibleCategories || compatibleCategories.includes(tool.category)));
    const connectorTools = external.success ? external.tools ?? [] : [];
    const failure = external.success ? external.partial_error : external.code ?? 'CONNECTOR_UNAVAILABLE';
    const hint = failure ? agentRecovery(failure).message : !connectorTools.length && !external.next_cursor
      ? accountOnly ? 'No eligible match for this origin and account selection. Do not substitute another tool or account.'
        : 'No matching provider tool was found on a connection available to Ask. This is not a query result or proof of missing provider permissions.'
      : 'Follow connector_next_cursor across accounts before deciding a match is unique. If the intended account is unclear, ask the user. Only describe candidates marked describe_required. A manual_only entry is catalog information, not available for execution in Ask. Never switch account or tool origin.';
    const merged = [...nativeTools.slice(0, args.action === 'search' ? 10 - connectorTools.length : nativeTools.length), ...connectorTools];
    return { ...result, ...(accountOnly && !external.success && { success: false }), tools: merged, count: merged.length,
      connector_status: external.success ? (failure ? 'partial' : 'available') : 'unavailable',
      ...(failure ? { connector_error: failure, connector_recovery: agentRecovery(failure) } : {}),
      connector_next_cursor: external.success ? external.next_cursor ?? null : null,
      truncated: external.truncated || (args.action === 'search' && nativeTools.length + connectorTools.length > 10),
      hint };
  } };
}