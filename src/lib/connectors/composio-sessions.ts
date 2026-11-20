import { getReviewedTool } from './reviewed-tools';
import { DATABASE_READ, TABLE_TOOL, tableArguments } from './supabase-table-policy';
import { projectTableNames } from './supabase-table-result';
import { validateTableDispatchSchema } from './reviewed-tool-schema';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ConnectorError, type Connector, type ConnectorProvider } from './types';
import { createComposioClient, invalidProviderResponse, validateJson, type ComposioClient } from './composio-transport';
import { verifyAccountIdentity } from './composio-accounts';
import { inputValue, providerId, providerValue, safeText, scopesSchema, toolkitSlug, toolSlug } from './composio-validation';

/**
 * Deliberate pinned REST backend, NOT a session-to-direct fallback. Current v3.1
 * sessions expose exact accounts but no version selector. The chosen execution
 * path is /tools/execute/{slug}; sessions, automatic auth and file loaders are
 * never created. Runtime authorization and reviewed-tool policy remain mandatory.
 */
type DescriptionInput = {
  credential: { apiKey: string; revision?: string };
  connector: Connector;
  provider?: ConnectorProvider;
  toolSlug: string;
  toolkitVersion?: string;
};
const versionSchema = z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/)
  .refine(value => !['latest', 'default', 'stable'].includes(value.toLowerCase()));
const toolSchema = z.object({
  slug: toolSlug, description: safeText(16_000), toolkit: z.object({ slug: toolkitSlug }),
  version: versionSchema, input_parameters: z.record(z.unknown()),
  scopes: scopesSchema, scope_requirements: z.record(z.unknown()).nullable(),
  no_auth: z.boolean(), is_deprecated: z.boolean(),
});

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function hashConnectorSchema(schema: unknown): string {
  validateJson(schema);
  return createHash('sha256').update(canonicalJson(schema)).digest('hex');
}

function validateSchema(schema: Record<string, unknown>): void {
  try { validateJson(schema); } catch { invalidProviderResponse(); }
  if (Buffer.byteLength(JSON.stringify(schema)) > 65_536) invalidProviderResponse();
  // No external reference resolving. Runtime applies a stricter supported JSON Schema subset.
  const walk = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (['$ref', '$dynamicRef', '$recursiveRef'].includes(key)) invalidProviderResponse();
      walk(item);
    }
  };
  walk(schema);
}

async function describe(client: ComposioClient, input: DescriptionInput) {
  getReviewedTool(input.toolSlug, input.connector.toolkit_slug);
  const tableArgs = input.toolSlug === TABLE_TOOL ? tableArguments(input.connector) : undefined;
  inputValue(toolSlug, input.toolSlug);
  inputValue(toolkitSlug, input.connector.toolkit_slug);
  if (input.toolkitVersion !== undefined) inputValue(versionSchema, input.toolkitVersion);
  const query = input.toolkitVersion ? `?${new URLSearchParams({ version: input.toolkitVersion })}` : '';
  const tool = providerValue(toolSchema, await client.request(`/tools/${input.toolSlug}${query}`));
  if (tool.slug !== input.toolSlug || tool.toolkit.slug !== input.connector.toolkit_slug
    || (input.toolkitVersion && tool.version !== input.toolkitVersion) || tool.is_deprecated || tool.no_auth) invalidProviderResponse();
  validateSchema(tool.input_parameters);
  if (tableArgs) {
    validateTableDispatchSchema(tool.input_parameters, tableArgs);
    if (tool.scope_requirements !== null || tool.scopes.length !== 1 || tool.scopes[0] !== DATABASE_READ) {
      denied('CONNECTOR_SCOPE_UNSUPPORTED', 'Supabase table discovery requires its reviewed read-only scope.');
    }
  }
  const descriptor = {
    slug: tool.slug, toolkitSlug: tool.toolkit.slug, toolkitVersion: tool.version,
    inputSchema: tool.input_parameters, scopes: tool.scopes, scopeRequirements: tool.scope_requirements,
  };
  return { ...descriptor, description: tool.description, schemaHash: hashConnectorSchema(descriptor) };
}

/** No session, connection, or external business action is created during describe. */
export async function describeConnectorTool(input: DescriptionInput) {
  return describe(createComposioClient(input.credential.apiKey), input);
}

function denied(code: string, message: string): never {
  throw Object.assign(new ConnectorError(code, message, 409), { executed: false, effectStarted: false });
}

/** Reject file/URL coercion inputs; data is never dereferenced or downloaded by this adapter. */
export function validateConnectorArguments(input: unknown): asserts input is Record<string, unknown> {
  validateJson(input);
  if (!input || Array.isArray(input) || typeof input !== 'object' || Buffer.byteLength(JSON.stringify(input)) > 48_000) {
    denied('CONNECTOR_INVALID_INPUT', 'Tool arguments must be a bounded JSON object.');
  }
  const visit = (item: unknown): void => {
    if (typeof item === 'string' && (/^(?:\/|~\/|\.\.?[\\/]|[a-z]:[\\/])/i.test(item)
      || /(?:https?|file|ftp|data|s3):\/\//i.test(item) || /^(?:data|file):/i.test(item))) {
      denied('CONNECTOR_UNSAFE_ARGUMENT', 'File paths and external URL loading are not supported.');
    }
    if (item && typeof item === 'object') for (const [key, value] of Object.entries(item)) {
      if (/(?:^|_)(?:file|files|filepath|path|url|uri|attachments?)(?:$|_)/i.test(key)
        || ['custom_auth_params', 'custom_connection_data', 'connected_account_id', 'user_id', 'version', 'text'].includes(key)) {
        denied('CONNECTOR_UNSAFE_ARGUMENT', 'This argument requires an unsupported execution capability.');
      }
      visit(value);
    }
  };
  visit(input);
}

function safeResult(value: unknown, apiKey: string): unknown {
  let nodes = 0;
  const redact = (item: unknown, depth: number): unknown => {
    if (++nodes > 10_000 || depth > 20) invalidProviderResponse(true);
    if (typeof item === 'string') {
      return item.replaceAll(apiKey, '[redacted]').replace(/\bBearer\s+[^\s"<>]+/gi, 'Bearer [redacted]');
    }
    if (item === null || typeof item === 'number' || typeof item === 'boolean') return item;
    if (Array.isArray(item)) return item.map(child => redact(child, depth + 1));
    if (!item || typeof item !== 'object') invalidProviderResponse(true);
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(item)) {
      // Provider pagination cursors are not credentials; preserve only the known
      // cursor spellings, while access/refresh/id tokens remain redacted.
      if ((/(?:token|secret|password|authorization|cookie|credential|api[_-]?key|session[_-]?(?:uri|info)|redirect[_-]?url)/i.test(key)
        && !['nextPageToken', 'next_page_token', 'previousPageToken'].includes(key))
        || ['__proto__', 'prototype', 'constructor'].includes(key)) continue;
      result[key] = redact(child, depth + 1);
    }
    return result;
  };
  return redact(value, 0);
}

export type ConnectorExecutionInput = DescriptionInput & {
  provider: ConnectorProvider;
  input: Record<string, unknown>;
  allowedTools: string[];
  requiredScopes: string[];
  toolkitVersion: string;
  schemaHash: string;
  /** Server-selected only for a direct tool result in the private instance assistant. */
  instanceResponse?: boolean;
  /** Required fresh authorization immediately before provider dispatch. */
  beforeDispatch: () => Promise<void>;
};

export async function executeConnectorTool(input: ConnectorExecutionInput) {
  let dispatched = false;
  try {
    inputValue(versionSchema, input.toolkitVersion);
    inputValue(z.string().regex(/^[a-f0-9]{64}$/), input.schemaHash);
    inputValue(z.array(toolSlug).min(1).max(100), input.allowedTools);
    inputValue(scopesSchema, input.requiredScopes);
    if (!input.allowedTools.includes(input.toolSlug) || typeof input.beforeDispatch !== 'function') {
      denied('CONNECTOR_TOOL_DENIED', 'This tool is not authorized for execution.');
    }
    const { connector, provider } = input;
    if (!provider || provider.id !== connector.provider_id || provider.site_id !== connector.site_id
      || provider.project_id !== connector.provider_project_id || provider.credential_revision !== input.credential.revision
      || provider.status !== 'active' || !connector.enabled || connector.revocation_pending || connector.provider_status !== 'ACTIVE') {
      denied('CONNECTOR_NOT_READY', 'The connector is not ready for execution.');
    }
    validateConnectorArguments(input.input);
    // Snapshot arguments before any await; caller mutation cannot change the authorized payload.
    const argumentsSnapshot = JSON.parse(JSON.stringify(input.input));
    if (input.toolSlug === TABLE_TOOL) {
      if (Object.keys(argumentsSnapshot).length) denied('CONNECTOR_INVALID_INPUT', 'This action accepts no caller arguments.');
      Object.assign(argumentsSnapshot, tableArguments(connector));
    }
    const client = createComposioClient(input.credential.apiKey);
    const descriptor = await describe(client, input);
    if (descriptor.schemaHash !== input.schemaHash) denied('CONNECTOR_SCHEMA_CHANGED', 'The tool schema changed. Describe the tool again.');
    // Gmail's documented user_id is a mailbox selector, not our execution actor.
    // Never accept it from the caller; bind only this reviewed action to the exact
    // authenticated account instead of permitting domain-wide delegation.
    if (descriptor.slug === 'GMAIL_FETCH_EMAILS') {
      const properties = descriptor.inputSchema.properties as Record<string, unknown> | undefined;
      if (properties && Object.hasOwn(properties, 'user_id')) argumentsSnapshot.user_id = 'me';
    }
    const account = await verifyAccountIdentity(client, {
      accountId: connector.provider_account_id, userId: provider.provider_user_id,
      toolkitSlug: connector.toolkit_slug, authConfigId: connector.auth_config_id,
    });
    if (descriptor.scopeRequirements !== null) denied('CONNECTOR_SCOPE_UNSUPPORTED', 'Structured provider scope requirements require review.');
    if (descriptor.slug === TABLE_TOOL) {
      // A PAT has no OAuth grants. The provider enforces Database:Read on this one
      // fixed action. No other permission or account kind is implied or accepted.
      if (!account.hostedSupabasePat || input.requiredScopes.some(scope => scope !== DATABASE_READ)) {
        denied('CONNECTOR_SCOPE_MISSING', 'A verified hosted Supabase token connection is required.');
      }
    } else if (![...descriptor.scopes, ...input.requiredScopes].every(scope => account.scopes.includes(scope))) {
      denied('CONNECTOR_SCOPE_MISSING', 'The account lacks the tool’s required OAuth scopes.');
    }
    await input.beforeDispatch();
    dispatched = true;
    const response = await client.request(`/tools/execute/${descriptor.slug}`, { method: 'POST', body: {
      connected_account_id: account.id, user_id: provider.provider_user_id,
      version: descriptor.toolkitVersion, arguments: argumentsSnapshot,
    } });
    if (input.instanceResponse) {
      const envelope = providerValue(z.object({ successful: z.literal(true), error: z.null() }).passthrough(), response, true);
      if (!Object.hasOwn(envelope, 'data')) invalidProviderResponse(true);
      // Redact the entire envelope, including diagnostics, before returning tool data.
      return safeResult(envelope, input.credential.apiKey) as { successful: true; data: unknown; [key: string]: unknown };
    }
    const data = providerValue(z.object({
      successful: z.boolean(), error: z.string().nullable(), data: z.record(z.unknown()), log_id: providerId.optional(),
    }), response, true);
    // A provider-level failure is not proof of no external effect. Never return its raw message.
    if (!data.successful || data.error !== null) invalidProviderResponse(true);
    if (descriptor.slug === TABLE_TOOL) {
      return { successful: true as const, data: safeResult(projectTableNames(data.data), input.credential.apiKey) };
    }
    return { successful: true as const, data: safeResult(data.data, input.credential.apiKey), logId: data.log_id };
  } catch (error) {
    if (error instanceof ConnectorError) {
      if (!dispatched) Object.assign(error, { executed: false, effectStarted: false });
      throw error;
    }
    if (dispatched) invalidProviderResponse(true);
    denied('CONNECTOR_EXECUTION_DENIED', 'The connector execution could not be authorized.');
  }
}