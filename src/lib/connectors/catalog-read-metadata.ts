import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ConnectorError, type Connector, type ConnectorProvider } from './types';
import { inputValue, providerValue, safeText, scopesSchema, toolkitSlug, toolSlug } from './composio-validation';
import { validateJson, type ComposioClient } from './composio-transport';
import { REVIEWED_CONNECTOR_TOOLS } from './reviewed-tools';
import { publishedList, sameSet } from './catalog-read-published';

export type ConnectorDescriptionInput = {
  /** Internal evidence from the authorization RPC; never copied from the request or provider descriptor. */
  localProjectRef?: string;
  credential: { apiKey: string; revision?: string }; connector: Connector;
  provider?: ConnectorProvider; toolSlug: string; toolkitVersion?: string;
  /** Set only by the private instance host after resolving effective policy. */
  catalogRead?: boolean;
  /** Internal runtime callback: never read from provider metadata or model arguments. */
  authorizeSelect?: import('./supabase-direct-query').AnalyticsPermit;
};
export type ConnectorToolDescription = {
  slug: string; toolkitSlug: string; toolkitVersion: string; inputSchema: Record<string, unknown>;
  scopes: string[]; scopeRequirements: Record<string, unknown> | null; description: string; schemaHash: string;
  catalogModelSchema?: Record<string, unknown>;
};

// Pin concrete toolkit release stamps, never provider-defined floating aliases.
const release = z.string().regex(/^20\d{6}_\d{2}$/);
const metadataSchema = z.object({
  slug: toolSlug, toolkit: z.object({ slug: toolkitSlug }), version: safeText(100), description: safeText(16_000),
  input_parameters: z.record(z.unknown()), output_parameters: z.record(z.unknown()).nullish(),
  scopes: scopesSchema, scope_requirements: z.record(z.unknown()).nullable(), no_auth: z.boolean(),
  is_deprecated: z.boolean(), deprecated: z.object({ is_deprecated: z.boolean().optional() }).nullish(),
  tags: z.unknown().optional(),
});
export type CatalogReadMetadata = z.infer<typeof metadataSchema>;

export function unsupportedAction(): never {
  throw new ConnectorError('TOOL_UNREVIEWED', 'This catalogue action is not verified for bounded instance reads. Choose another action or use the provider directly.', 403);
}
export function unsupportedSchema(): never {
  throw new ConnectorError('SCHEMA_UNSUPPORTED', 'This action cannot be projected to a bounded read contract. Choose another action.', 409);
}
export function unsupportedScopes(): never {
  throw new ConnectorError('CONNECTOR_SCOPE_UNSUPPORTED', 'Read-only authority could not be verified. Use a dedicated resource-scoped connection or the provider directly.', 409);
}
export function changed(): never {
  throw new ConnectorError('CONNECTOR_SCHEMA_CHANGED', 'The pinned action or resource binding changed. Describe the action again.', 409);
}

export async function verifyCatalogBinding({ connector, provider, credential, toolSlug: slug }: ConnectorDescriptionInput) {
  if (REVIEWED_CONNECTOR_TOOLS.some(tool => tool.slug === slug)) unsupportedAction(); // no alternate path around a reviewed policy
  if (!provider || provider.provider !== 'composio' || provider.id !== connector.provider_id || provider.site_id !== connector.site_id
    || provider.provider_user_id !== connector.site_id || !provider.project_id || provider.project_id !== connector.provider_project_id
    || !credential.revision || credential.revision !== provider.credential_revision || provider.status !== 'active'
    || connector.provider_account_id === 'instant_account' || !connector.verified_at || connector.enabled !== true
    || connector.provider_status !== 'ACTIVE' || connector.revocation_pending !== false) {
    throw new ConnectorError('CONNECTOR_NOT_READY', 'Verify the active private account and provider project binding before using this action.', 409);
  }
  const { readProviderBinding, readTokenProviderBinding } = await import('./provider-binding');
  const { projectId } = await (connector.toolkit_slug === 'supabase' ? readTokenProviderBinding : readProviderBinding)(connector.site_id, credential.revision);
  if (projectId !== provider.project_id || (credential.revision.startsWith('platform:') &&
    credential.revision !== `platform:${createHash('sha256').update(credential.apiKey).digest('hex')}`)) {
    throw new ConnectorError('PROVIDER_REVALIDATION_REQUIRED', 'Revalidate the credential for this connector project.', 409);
  }
  return provider;
}

export async function readCatalogMetadata(client: ComposioClient, input: ConnectorDescriptionInput) {
  const slug = inputValue(toolSlug, input.toolSlug);
  inputValue(toolkitSlug, input.connector.toolkit_slug);
  const kit = input.connector.toolkit_slug;
  const profile = publishedList(kit, slug);
  const report = kit === 'supabase' && slug === 'SUPABASE_RUN_READ_ONLY_QUERY';
  const pin = report ? '20261116_00' : profile?.version;
  const version = input.toolkitVersion === undefined ? pin : inputValue(release, input.toolkitVersion);
  if (pin && version !== pin) changed();
  const raw = await client.request(`/tools/${slug}${version ? `?version=${version}` : ''}`);
  // Validate original JSON before passing through a parser that strips unknown keys.
  try { validateJson(raw); } catch { unsupportedSchema(); }
  const tool = providerValue(metadataSchema, raw);
  if (tool.slug !== slug || tool.toolkit.slug !== input.connector.toolkit_slug || (version && version !== tool.version)) changed();
  if (!release.safeParse(tool.version).success || tool.no_auth || tool.is_deprecated || tool.deprecated?.is_deprecated) unsupportedAction();
  if (!Array.isArray(tool.tags) || !tool.tags.includes('readOnlyHint')) unsupportedAction();
  // Open-world/category tags qualify only on exact published profiles with independent
  // live scope, shape, project and account checks. They do not widen the generic path.
  const tags = report ? ['Database', 'important', 'openWorldHint', 'readOnlyHint'] : profile?.tags;
  if (tags ? !sameSet(tool.tags, tags) : tool.tags.some(tag => tag !== 'readOnlyHint' && tag !== 'idempotentHint')) unsupportedAction();
  if (tool.scope_requirements !== null) unsupportedScopes();
  return tool;
}
