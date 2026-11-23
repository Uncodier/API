import { assertScopes, screenAllowed } from './action-policy';
import { resolveConnectorAction, listUsableConnectors, loadConnectorCredential } from './access';
import { describeConnectorTool, executeConnectorTool } from './composio-sessions';
import { ConnectorError, type AuthorizedConnector, type ConnectorContext } from './types';
import { createActionRanker } from './action-search';
import { connectorToolRef, getReviewedTool, parseConnectorToolRef, policyReviewedTools, REVIEWED_CONNECTOR_TOOLS, type ReviewedConnectorTool } from './reviewed-tools';
import { validateConnectorInput } from './schema-validation';
import { reviewedInputSchema, assertReviewedInputLimits } from './reviewed-tool-schema';
import { loadToolScreenAccess } from '@/app/api/agents/tools/router/screen-access';
import type { ConnectorContextResolver } from './host-context';
import { catalogDefinition, catalogGrant, catalogInstance, catalogScreens, instanceCatalogPage } from './instance-catalog-discovery';

import { ConnectorArgumentError } from './connector-argument-error';
import { isSupabaseReportAction } from './provider-report-action';
import { privateResultBinding, checkPrivateDestination, deliverPrivateResult } from './private-result-delivery';

import type { ConnectorCandidate, ConnectorFilters } from './connector-discovery-types';
export type { ConnectorCandidate, ConnectorFilters } from './connector-discovery-types';
const binding = (value: AuthorizedConnector) => JSON.stringify([value.connector, value.provider, value.policy, value.requestOnly, value.localProjectRef]);
const actor = (context: ConnectorContext) => JSON.stringify(context);

/** Historical restricted runtime. Production uses this only to reopen an owner's saved report
 * choice, never as a fallback from the provider-direct Robots gateway. */
export function createConnectorRuntime(resolveContext: ConnectorContextResolver) {
  const rankActions = createActionRanker();
  async function authorize(name: string) {
    const { connectorId, toolSlug } = parseConnectorToolRef(name);
    const context = await resolveContext();
    if (!['assistant', 'direct'].includes(context.host) || (context.host === 'assistant' && !context.agentId)) {
      throw new ConnectorError('HOST_DISABLED', 'This connector host has no supported authority.', 403);
    }
    const reviewed = REVIEWED_CONNECTOR_TOOLS.find(t => t.slug === toolSlug);
    const mayRequest = !!context.instanceId && !!context.requestId;
    const catalogRead = !reviewed && catalogInstance(context);
    const authorized = catalogRead ? await resolveConnectorAction(context, connectorId, toolSlug, false, true)
      : await resolveConnectorAction(context, connectorId, toolSlug, mayRequest);
    const toolkit = authorized.connector.toolkit_slug;
    // Never reinterpret an incompatible curated action as an ordinary catalog read.
    const dynamic = catalogRead && catalogGrant(authorized, toolSlug);
    const tool = dynamic ? catalogDefinition(toolSlug, toolkit) : getReviewedTool(toolSlug, toolkit);
    const access = await loadToolScreenAccess(context);
    if (!screenAllowed(tool, access) || (dynamic && !catalogScreens(access))) {
      throw new ConnectorError('ACCESS_DENIED', 'Connector business-screen access denied.', 403);
    }
    if (!dynamic) assertScopes(authorized, tool);
    return { context, authorized, tool, dynamic };
  }

  return {
    async search(filters: ConnectorFilters = {}) {
      const context = await resolveContext();
      if (!['assistant', 'direct'].includes(context.host) || (context.host === 'assistant' && !context.agentId)) {
        throw new ConnectorError('HOST_DISABLED', 'This connector host has no supported authority.', 403);
      }
      const access = await loadToolScreenAccess(context);
      const permitted = await listUsableConnectors(context, !!context.instanceId && !!context.requestId, catalogInstance(context));
      const eligible: { tool: ReviewedConnectorTool; id: string; requestOnly?: true }[] = [];
      if (filters.connector_id && !/^[0-9a-f-]{36}$/i.test(filters.connector_id)) throw new ConnectorError('INVALID_FILTER', 'Invalid connector filter.', 400);
      for (const authorized of permitted) {
        if (filters.connector_id && authorized.connector.id !== filters.connector_id) continue;
        for (const tool of policyReviewedTools(authorized.connector, authorized.policy)) {
          if (!screenAllowed(tool, access) || (filters.domain && !tool.domains.includes(filters.domain)) ||
              (filters.category && filters.category !== tool.category)) continue;
          try { assertScopes(authorized, tool); } catch { continue; }
          eligible.push({ tool, id: authorized.connector.id, requestOnly: authorized.requestOnly });
        }
      }
      const scores = await rankActions(eligible.map(item => item.tool), filters.query);
      const candidates: ConnectorCandidate[] = eligible.filter(({ tool }) => scores.get(tool.slug)! > 0)
        .sort((a, b) => scores.get(b.tool.slug)! - scores.get(a.tool.slug)! || a.id.localeCompare(b.id) || a.tool.slug.localeCompare(b.tool.slug))
        .map(({ tool, id, requestOnly }) => ({ ...(requestOnly && {request_only: true as const}), name: connectorToolRef(id, tool.slug), description: tool.description,
          category: tool.category, domains: tool.domains, connector_id: id, toolkit: tool.toolkit, availability: 'describe_required' }));
      return instanceCatalogPage(context, filters, candidates, permitted, access);
    },

    async describe(name: string) {
      const { context, authorized, tool, dynamic } = await authorize(name);
      const credential = await loadConnectorCredential(context.siteId);
      if (credential.revision !== authorized.provider.credential_revision) {
        throw new ConnectorError('STALE_CREDENTIAL', 'Refresh the provider credential binding.', 409);
      }
      const descriptor = await describeConnectorTool({ credential, connector: authorized.connector,
        provider: authorized.provider, ...(dynamic && { catalogRead: true, localProjectRef: authorized.localProjectRef }), toolSlug: tool.slug });
      if (descriptor.slug !== tool.slug || descriptor.toolkitSlug !== tool.toolkit || !descriptor.toolkitVersion || !descriptor.schemaHash) {
        throw new ConnectorError('SCHEMA_CHANGED', 'The connector tool identity could not be verified.', 409);
      }
      const modelSchema = dynamic ? descriptor.catalogModelSchema : reviewedInputSchema(tool.slug, descriptor.inputSchema);
      if (!modelSchema) throw new ConnectorError('SCHEMA_UNSUPPORTED', 'No safe input contract for this action.', 409);
      if (descriptor.scopeRequirements !== null) throw new ConnectorError('SCOPES_UNSUPPORTED', 'Structured OAuth requirements need review.', 409);
      if (!dynamic) assertScopes(authorized, tool, descriptor.scopes);
      const current = await authorize(name);
      if (actor(current.context) !== actor(context) || binding(current.authorized) !== binding(authorized)) {
        throw new ConnectorError('ACCESS_CHANGED', 'Connector authority changed; describe the tool again.', 409);
      }
      return { name, description: dynamic ? descriptor.description : tool.description, category: tool.category, domains: tool.domains,
        connector_id: authorized.connector.id, toolkit: tool.toolkit, version: descriptor.toolkitVersion,
        schema_hash: descriptor.schemaHash, parameters: { type: 'object', additionalProperties: false,
          required: ['version', 'schema_hash', 'arguments'], properties: {
            version: { type: 'string', const: descriptor.toolkitVersion },
            schema_hash: { type: 'string', const: descriptor.schemaHash }, arguments: modelSchema,
          } }, effect: 'read', require_approval: authorized.requestOnly === true,
        expected_use: 'Use the described version, schema_hash and arguments. Keep the JSON envelope within 32,000 UTF-16 units. Do not supply credentials, account overrides, file paths or URLs. Only a verified pre-dispatch argument rejection is a reason to correct the input; do not replay an uncertain call. Do not substitute a list of names, a sample, or another account for the requested result. A descriptor is not an access grant.' };
    },

    async call(name: string, input: unknown) {
      let dispatched = false;
      try {
        const serialized = JSON.stringify(input);
        if (!serialized || serialized.length > 32000) throw new ConnectorArgumentError({path:'arguments',rule:'bounded'});
        input = JSON.parse(serialized);
        const { context, authorized, tool, dynamic } = await authorize(name);
        const envelope = input as { version?: unknown; schema_hash?: unknown; arguments?: unknown } | null;
        if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
          Object.keys(envelope).some(key => !['version', 'schema_hash', 'arguments'].includes(key)) ||
          typeof envelope.version !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(envelope.version) ||
          ['latest', 'default', 'stable'].includes(envelope.version.toLowerCase()) ||
          typeof envelope.schema_hash !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.schema_hash)) {
          throw new ConnectorError('DESCRIBE_REQUIRED', 'Use the described version, schema_hash and arguments envelope.', 409);
        }
        const credential = await loadConnectorCredential(context.siteId);
        if (credential.revision !== authorized.provider.credential_revision) throw new ConnectorError('STALE_CREDENTIAL', 'Provider credential changed.', 409);
        if (!envelope.arguments || typeof envelope.arguments !== 'object' || Array.isArray(envelope.arguments)) {
          throw new ConnectorArgumentError({path:'arguments',rule:'json_object'});
        }
        const args = envelope.arguments as Record<string, unknown>;
        // The catalog adapter verifies and projects its pinned descriptor with live grants immediately
        // before dispatch. Do not double-fetch that metadata. Curated request-only proposals still
        // need their described contract here, before any approval request can be written.
        if (!dynamic) {
          const descriptor = await describeConnectorTool({ credential, connector: authorized.connector,
            provider: authorized.provider, toolSlug: tool.slug, toolkitVersion: envelope.version });
          if (descriptor.schemaHash !== envelope.schema_hash || descriptor.toolkitVersion !== envelope.version ||
            descriptor.slug !== tool.slug || descriptor.toolkitSlug !== tool.toolkit) {
            throw new ConnectorError('SCHEMA_CHANGED', 'The connector schema changed; describe this tool again.', 409);
          }
          assertScopes(authorized, tool, descriptor.scopes);
          if (descriptor.scopeRequirements !== null) throw new ConnectorError('SCOPES_UNSUPPORTED', 'Structured OAuth requirements need review.', 409);
          validateConnectorInput(reviewedInputSchema(tool.slug, descriptor.inputSchema), envelope.arguments);
          assertReviewedInputLimits(tool.slug, envelope.arguments);
          if (authorized.requestOnly === true) {
            const current = await authorize(name);
            if (actor(current.context) !== actor(context) || binding(current.authorized) !== binding(authorized)) {
              throw new ConnectorError('ACCESS_CHANGED', 'Connector authority changed before proposal.', 409);
            }
            const { proposeInteractiveConnectorAction } = await import('./approval-proposals');
            const proposal = await proposeInteractiveConnectorAction(context, authorized, descriptor, envelope.arguments);
            return { success: true, ...proposal };
          }
        }
        const destination = context.host === 'assistant' ? privateResultBinding(context, authorized, tool.slug, dynamic) : null;
        const analytics = dynamic && isSupabaseReportAction(tool.toolkit, tool.slug)
          ? (await import('./analytics-release')).prepareReportRelease(destination, authorized.connector.supabase_project_ref, args)
          : undefined;
        const result = await executeConnectorTool({ credential, connector: authorized.connector, provider: authorized.provider,
          ...(dynamic && { catalogRead: true, localProjectRef: authorized.localProjectRef }), ...(analytics && { authorizeSelect: analytics.permit }),
          toolSlug: tool.slug, input: args, allowedTools: [tool.slug], toolkitVersion: envelope.version,
          schemaHash: envelope.schema_hash, requiredScopes: tool.requiredScopes, beforeDispatch: async () => {
            const current = await authorize(name);
            if (actor(current.context) !== actor(context) || binding(current.authorized) !== binding(authorized)) {
              throw new ConnectorError('ACCESS_CHANGED', 'Connector authority changed before dispatch.', 409);
            }
            if (analytics) await analytics.confirm();
            else if (destination) await checkPrivateDestination(destination);
            dispatched = true;
          } });
        const after = await authorize(name);
        if (actor(after.context) !== actor(context) || binding(after.authorized) !== binding(authorized)) {
          throw new ConnectorError('ACCESS_CHANGED', 'Connector result is no longer available.', 403);
        }
        if (destination) return await deliverPrivateResult(destination, result, credential.apiKey, envelope.version, envelope.schema_hash, await analytics?.confirm());
        return { success: true, name, result, receipt: { connector_id: authorized.connector.id,
          tool: tool.slug, version: envelope.version, effect: 'read', status: 'completed' } };
      } catch (error) {
        if (error && typeof error === 'object') {
          if (!dispatched) Object.assign(error, { executed: false, effectStarted: false });
          else {
            // A postflight authorization sub-call may itself fail before it starts. That cannot
            // undo the preceding provider dispatch or prove its outcome to the caller.
            Reflect.deleteProperty(error, 'executed'); Reflect.deleteProperty(error, 'effectStarted');
          }
        }
        throw error;
      }
    },
  };
}

export type ConnectorRuntime = ReturnType<typeof createConnectorRuntime>;