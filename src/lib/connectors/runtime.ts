import { assertScopes, screenAllowed } from './action-policy';
import { resolveConnectorAction, listUsableConnectors, loadConnectorCredential } from './access';
import { describeConnectorTool, executeConnectorTool } from './composio-sessions';
import { ConnectorError, type AuthorizedConnector, type ConnectorContext } from './types';
import { createActionRanker } from './action-search';
import { connectorToolRef, getReviewedTool, parseConnectorToolRef, policyReviewedTools, type ReviewedConnectorTool } from './reviewed-tools';
import { validateConnectorInput } from './schema-validation';
import { reviewedInputSchema, assertReviewedInputLimits } from './reviewed-tool-schema';
import { loadToolScreenAccess } from '@/app/api/agents/tools/router/screen-access';
import type { ConnectorContextResolver } from './host-context';
import { createHash } from 'node:crypto';

export type ConnectorFilters = { query?: string; domain?: string; category?: string; connector_id?: string; cursor?: string };
export type ConnectorCandidate = {
  name: string; description: string; category: string; domains: string[];
  connector_id: string; toolkit: string; availability: 'describe_required'; request_only?: true;
};
const binding = (value: AuthorizedConnector) => JSON.stringify([value.connector, value.provider, value.policy, value.requestOnly]);
const actor = (context: ConnectorContext) => JSON.stringify(context);

/** Descriptions carry version/hash across turns, never authority or cached grants. */
export function createConnectorRuntime(resolveContext: ConnectorContextResolver) {
  const rankActions = createActionRanker();
  async function authorize(name: string) {
    const { connectorId, toolSlug } = parseConnectorToolRef(name);
    const context = await resolveContext();
    if (!['assistant', 'direct'].includes(context.host) || (context.host === 'assistant' && !context.agentId)) {
      throw new ConnectorError('HOST_DISABLED', 'This connector host has no supported authority.', 403);
    }
    const authorized = await resolveConnectorAction(context, connectorId, toolSlug, !!context.instanceId && !!context.requestId);
    const tool = getReviewedTool(toolSlug, authorized.connector.toolkit_slug);
    if (!screenAllowed(tool, await loadToolScreenAccess(context))) {
      throw new ConnectorError('ACCESS_DENIED', 'Connector business-screen access denied.', 403);
    }
    assertScopes(authorized, tool);
    return { context, authorized, tool };
  }

  return {
    async search(filters: ConnectorFilters = {}) {
      const context = await resolveContext();
      if (!['assistant', 'direct'].includes(context.host) || (context.host === 'assistant' && !context.agentId)) {
        throw new ConnectorError('HOST_DISABLED', 'This connector host has no supported authority.', 403);
      }
      const access = await loadToolScreenAccess(context);
      const permitted = await listUsableConnectors(context, !!context.instanceId && !!context.requestId);
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
      const digest = createHash('sha256').update(JSON.stringify([actor(context), filters.query, filters.domain,
        filters.category, filters.connector_id, candidates.map(item => [item.name, item.request_only])])).digest('hex').slice(0, 24);
      let offset = 0;
      if (filters.cursor) {
        const match = /^([a-f0-9]{24}):(\d{1,5})$/.exec(filters.cursor);
        if (!match || match[1] !== digest || Number(match[2]) > candidates.length) throw new ConnectorError('STALE_CURSOR', 'Connector inventory changed. Search again without the cursor.', 409);
        offset = Number(match[2]);
      }
      const more = offset + 5 < candidates.length;
      return { tools: candidates.slice(offset, offset + 5), truncated: more,
        next_cursor: more ? `${digest}:${offset + 5}` : null };
    },

    async describe(name: string) {
      const { context, authorized, tool } = await authorize(name);
      const credential = await loadConnectorCredential(context.siteId);
      if (credential.revision !== authorized.provider.credential_revision) {
        throw new ConnectorError('STALE_CREDENTIAL', 'Refresh the provider credential binding.', 409);
      }
      const descriptor = await describeConnectorTool({ credential, connector: authorized.connector,
        provider: authorized.provider, toolSlug: tool.slug });
      if (descriptor.slug !== tool.slug || descriptor.toolkitSlug !== tool.toolkit || !descriptor.toolkitVersion || !descriptor.schemaHash) {
        throw new ConnectorError('SCHEMA_CHANGED', 'The connector tool identity could not be verified.', 409);
      }
      const modelSchema = reviewedInputSchema(tool.slug, descriptor.inputSchema);
      if (descriptor.scopeRequirements !== null) throw new ConnectorError('SCOPES_UNSUPPORTED', 'Structured OAuth requirements need review.', 409);
      assertScopes(authorized, tool, descriptor.scopes);
      const current = await authorize(name);
      if (actor(current.context) !== actor(context) || binding(current.authorized) !== binding(authorized)) {
        throw new ConnectorError('ACCESS_CHANGED', 'Connector authority changed; describe the tool again.', 409);
      }
      return { name, description: tool.description, category: tool.category, domains: tool.domains,
        connector_id: authorized.connector.id, toolkit: tool.toolkit, version: descriptor.toolkitVersion,
        schema_hash: descriptor.schemaHash, parameters: { type: 'object', additionalProperties: false,
          required: ['version', 'schema_hash', 'arguments'], properties: {
            version: { type: 'string', const: descriptor.toolkitVersion },
            schema_hash: { type: 'string', const: descriptor.schemaHash }, arguments: modelSchema,
          } }, effect: 'read', require_approval: authorized.requestOnly === true,
        expected_use: 'tools call args must contain version, schema_hash, and arguments from this description. These references survive turns but never grant access.' };
    },

    async call(name: string, input: unknown) {
      let dispatched = false;
      try {
        const serialized = JSON.stringify(input);
        if (!serialized || serialized.length > 32000) throw new ConnectorError('INVALID_TOOL_ARGUMENTS', 'Arguments must be bounded JSON.', 400);
        input = JSON.parse(serialized);
        const { context, authorized, tool } = await authorize(name);
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
        const result = await executeConnectorTool({ credential, connector: authorized.connector, provider: authorized.provider,
          instanceResponse: context.host === 'assistant',
          toolSlug: tool.slug, input: envelope.arguments, allowedTools: [tool.slug], toolkitVersion: descriptor.toolkitVersion,
          schemaHash: descriptor.schemaHash, requiredScopes: tool.requiredScopes, beforeDispatch: async () => {
            const current = await authorize(name);
            if (actor(current.context) !== actor(context) || binding(current.authorized) !== binding(authorized)) {
              throw new ConnectorError('ACCESS_CHANGED', 'Connector authority changed before dispatch.', 409);
            }
            dispatched = true;
          } });
        const after = await authorize(name);
        if (actor(after.context) !== actor(context) || binding(after.authorized) !== binding(authorized)) {
          throw new ConnectorError('ACCESS_CHANGED', 'Connector result is no longer available.', 403);
        }
        return { success: true, name, result, receipt: { connector_id: authorized.connector.id,
          tool: tool.slug, version: descriptor.toolkitVersion, effect: 'read', status: 'completed' } };
      } catch (error) {
        if (!dispatched && error && typeof error === 'object') Object.assign(error, { executed: false, effectStarted: false });
        throw error;
      }
    },
  };
}

export type ConnectorRuntime = ReturnType<typeof createConnectorRuntime>;