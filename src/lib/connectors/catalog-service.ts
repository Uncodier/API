import { z } from 'zod';
import { listVisibleConnectors, loadConnectorCredential, requireConnectorSiteAccess } from './access';
import { getToolkit, listToolkits, type ComposioToolkit } from './composio-catalog';
import { managedOAuthPreset } from './managed-oauth-policy';
import { canHostConnection, canUseHostedConfig, connectionSetup, existingSetupKey, needsNoAccount } from './connection-onboarding';
import { readAuthConfigs } from './auth-config-provisioning';
import { createComposioClient } from './composio-transport';
import { toolkitSlug } from './composio-validation';
import { CONNECTOR_DOMAINS, getDomainSkills, getToolkitDomains } from './domains';
import { projectConnections } from './connection-service';
import { ConnectorError, type Connector } from './types';
import { catalogPageCursor, catalogPageNumber, catalogPagination } from './catalog-pagination';
import { filteredCatalogPage, paginateFilteredCatalog, scanConnectedCatalog, scanProviderCatalog } from './filtered-catalog';

export const siteQuerySchema = z.object({ site_id: z.string().uuid() }).strict();
export const toolkitSlugSchema = toolkitSlug;
export const domainCountsQuerySchema = siteQuerySchema.extend({
  q: z.string().trim().max(200).regex(/^[^\u0000-\u001f\u007f]*$/).optional(),
  tab: z.enum(['all', 'connected']).default('all'),
});
export const catalogQuerySchema = domainCountsQuerySchema.extend({
  category: z.string().max(80).refine(value => CONNECTOR_DOMAINS.some(domain => domain.id === value)).optional(),
  cursor: z.string().min(1).max(2048).regex(/^[^\u0000-\u0020\u007f]+$/).optional(),
  page: catalogPageNumber.optional(),
}).strict().refine(query => !(query.cursor && query.page), 'Choose a page or cursor, not both');
export type CatalogQuery = z.infer<typeof catalogQuerySchema>;

const domains = () => CONNECTOR_DOMAINS.map(domain => ({
  id: domain.id, label: domain.label, skill_slugs: [...domain.skillSlugs],
}));

function toolkitDomains(toolkit: ComposioToolkit) {
  return getToolkitDomains(toolkit.slug, toolkit.categories.flatMap(category => [category.slug, category.name]));
}

export function projectToolkit(toolkit: ComposioToolkit, visible: Pick<Connector, 'toolkit_slug'>[]) {
  const mapped = toolkitDomains(toolkit);
  return {
    slug: toolkit.slug, name: toolkit.name, description: toolkit.description, logo: toolkit.logo_url,
    domains: mapped, skills: getDomainSkills(mapped), tools_count: toolkit.tools_count,
    auth_schemes: toolkit.auth_schemes, toolkit_type: toolkit.toolkit_type,
    managed_oauth: toolkit.advertises_managed_oauth === true && toolkit.enabled !== false && toolkit.slug !== 'supabase',
    connection_count: visible.filter(connection => connection.toolkit_slug === toolkit.slug).length,
  };
}

function connectedToolkitSlugs(visible: Pick<Connector, 'toolkit_slug'>[]) {
  return [...new Set(visible.map(connection => connection.toolkit_slug))].sort();
}

async function matchingConnectedToolkits(client: ReturnType<typeof createComposioClient>, slugs: string[], query?: string) {
  const toolkits = await scanConnectedCatalog(client, slugs);
  const search = query?.toLowerCase();
  return search ? toolkits.filter(toolkit => `${toolkit.name} ${toolkit.slug} ${toolkit.description}`.toLowerCase().includes(search)) : toolkits;
}

export async function getConnectorDomainCounts(userId: string, query: z.input<typeof domainCountsQuerySchema>) {
  const input = domainCountsQuerySchema.parse(query);
  await requireConnectorSiteAccess(input.site_id, userId);
  const credential = await loadConnectorCredential(input.site_id);
  const client = createComposioClient(credential.apiKey);
  const toolkits = input.tab === 'connected'
    ? await matchingConnectedToolkits(client, connectedToolkitSlugs(await listVisibleConnectors(input.site_id, userId)), input.q)
    : await scanProviderCatalog(client, input.q || undefined);
  const counts = Object.fromEntries(CONNECTOR_DOMAINS.map(({ id }) => [id, 0]));
  for (const toolkit of toolkits) {
    for (const id of toolkitDomains(toolkit)) counts[id] += 1;
  }
  return { total: toolkits.length, counts };
}

/** Browsing metadata never creates a provider binding, auth attempt or tool session. */
export async function getConnectorCatalog(userId: string, query: CatalogQuery) {
  const input = catalogQuerySchema.parse(query);
  const access = await requireConnectorSiteAccess(input.site_id, userId);
  let credential;
  try { credential = await loadConnectorCredential(input.site_id); }
  catch (error) {
    if (!(error instanceof ConnectorError) || error.code !== 'NOT_CONFIGURED') throw error;
    return { items: [], domains: domains(), next_cursor: null, can_manage: access.can_manage, configured: false, total: null };
  }
  const visible = await listVisibleConnectors(input.site_id, userId);
  const client = createComposioClient(credential.apiKey);
  const connected = input.tab === 'connected';
  const slugs = connected ? connectedToolkitSlugs(visible) : [];
  const limit = connected ? 20 : 50;
  const metadata = { domains: domains(), can_manage: access.can_manage, configured: true, credential_source: credential.source };

  if (input.category || (connected && input.q)) {
    const page = filteredCatalogPage(input.cursor, input.page);
    const candidates = connected ? await matchingConnectedToolkits(client, slugs, input.q) : await scanProviderCatalog(client, input.q || undefined);
    const matches = candidates.map(toolkit => projectToolkit(toolkit, visible)).filter(toolkit =>
      !input.category || toolkit.domains.includes(input.category));
    return { ...metadata, ...paginateFilteredCatalog(matches, page, limit) };
  }

  let page: { items: ComposioToolkit[]; next_cursor: string | null; total_items: number | null };
  if (connected) {
    if (input.cursor && !/^connected:(0|[1-9][0-9]{0,3})$/.test(input.cursor)) {
      throw new ConnectorError('INVALID_REQUEST', 'Invalid connected catalogue cursor.', 400);
    }
    const offset = input.page ? (input.page - 1) * limit : input.cursor ? Number(input.cursor.split(':')[1]) : 0;
    const selected = slugs.slice(offset, offset + limit);
    page = {
      items: await Promise.all(selected.map(slug => getToolkit(client, slug))),
      next_cursor: offset + limit < slugs.length ? `connected:${offset + limit}` : null,
      total_items: slugs.length,
    };
  } else {
    page = await listToolkits(client, { query: input.q || undefined,
      cursor: input.page ? catalogPageCursor(input.page, limit) : input.cursor, limit });
  }
  return {
    ...metadata, items: page.items.map(toolkit => projectToolkit(toolkit, visible)), next_cursor: page.next_cursor, total: page.total_items,
    ...catalogPagination(input.page ?? 1, limit, page.total_items, !!page.next_cursor),
  };
}

export async function getConnectorDetail(siteId: string, userId: string, slug: string) {
  siteQuerySchema.parse({ site_id: siteId }); toolkitSlugSchema.parse(slug);
  const access = await requireConnectorSiteAccess(siteId, userId);
  const credential = await loadConnectorCredential(siteId);
  const visible = (await listVisibleConnectors(siteId, userId)).filter(connection => connection.toolkit_slug === slug);
  const client = createComposioClient(credential.apiKey);
  // Auth configuration references are management metadata, never an ordinary member's ACL.
  const [toolkit, configs] = await Promise.all([
    getToolkit(client, slug), access.can_manage ? readAuthConfigs(client, slug, true) : null,
  ]);
  const connections = await projectConnections(siteId, userId, visible);
  return {
    toolkit: projectToolkit(toolkit, connections), connections,
    auth_configs: (configs ?? []).filter(config => config.status === 'ENABLED').map(config => ({ id: config.id, name: config.name, auth_scheme: config.authScheme ?? 'Unknown',
      ...(canUseHostedConfig(toolkit, config) && { setup_key: existingSetupKey(credential.revision, toolkit, config) }) })),
    can_create_managed_oauth: !!configs && !configs.length && !!managedOAuthPreset(toolkit),
    ...(configs ? { connection_setup: connectionSetup(toolkit, configs, credential.revision) }
      : canHostConnection(toolkit) && needsNoAccount(toolkit) ? { connection_setup: { kind: 'no_auth' as const } } : {}),
    auth_configs_next_cursor: null, can_manage: access.can_manage, credential_source: credential.source,
  };
}