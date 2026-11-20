import { z } from 'zod';
import { listVisibleConnectors, loadConnectorCredential, requireConnectorSiteAccess } from './access';
import { getToolkit, listAuthConfigs, listToolkits, type ComposioToolkit } from './composio-catalog';
import { managedOAuthPreset } from './managed-oauth-policy';
import { createComposioClient } from './composio-transport';
import { CONNECTOR_DOMAINS, getDomainSkills, getToolkitDomains } from './domains';
import { projectConnections } from './connection-service';
import { ConnectorError, type Connector } from './types';
import { catalogPageCursor, catalogPageNumber, catalogPagination } from './catalog-pagination';
import { filteredCatalogPage, paginateFilteredCatalog, scanConnectedCatalog, scanProviderCatalog } from './filtered-catalog';

export const siteQuerySchema = z.object({ site_id: z.string().uuid() }).strict();
export const toolkitSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/);
export const catalogQuerySchema = siteQuerySchema.extend({
  q: z.string().trim().max(200).regex(/^[^\u0000-\u001f\u007f]*$/).optional(),
  category: z.string().max(80).refine(value => CONNECTOR_DOMAINS.some(domain => domain.id === value)).optional(),
  tab: z.enum(['all', 'connected']).default('all'),
  cursor: z.string().min(1).max(2048).regex(/^[^\u0000-\u0020\u007f]+$/).optional(),
  page: catalogPageNumber.optional(),
}).strict().refine(query => !(query.cursor && query.page), 'Choose a page or cursor, not both');
export type CatalogQuery = z.infer<typeof catalogQuerySchema>;

const domains = () => CONNECTOR_DOMAINS.map(domain => ({
  id: domain.id, label: domain.label, skill_slugs: [...domain.skillSlugs],
}));

export function projectToolkit(toolkit: ComposioToolkit, visible: Pick<Connector, 'toolkit_slug'>[]) {
  const mapped = getToolkitDomains(toolkit.slug, toolkit.categories.flatMap(category => [category.slug, category.name]));
  return {
    slug: toolkit.slug, name: toolkit.name, description: toolkit.description, logo: toolkit.logo_url,
    domains: mapped, skills: getDomainSkills(mapped), tools_count: toolkit.tools_count,
    auth_schemes: toolkit.auth_schemes,
    connection_count: visible.filter(connection => connection.toolkit_slug === toolkit.slug).length,
  };
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
  const slugs = connected ? [...new Set(visible.map(connection => connection.toolkit_slug))].sort() : [];
  const limit = connected ? 20 : 50;
  const metadata = { domains: domains(), can_manage: access.can_manage, configured: true, credential_source: credential.source };

  if (input.category || (connected && input.q)) {
    const page = filteredCatalogPage(input.cursor, input.page);
    const candidates = connected ? await scanConnectedCatalog(client, slugs) : await scanProviderCatalog(client, input.q || undefined);
    const search = connected ? input.q?.toLowerCase() : undefined;
    const matches = candidates.map(toolkit => projectToolkit(toolkit, visible)).filter(toolkit =>
      (!input.category || toolkit.domains.includes(input.category))
      && (!search || `${toolkit.name} ${toolkit.slug} ${toolkit.description}`.toLowerCase().includes(search)));
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
  const toolkit = await getToolkit(client, slug);
  // Auth configuration references are management metadata, never an ordinary member's ACL.
  const configs = access.can_manage ? await listAuthConfigs(client, slug) : null;
  if (configs) {
    const seen = new Set<string>();
    for (let reads = 1; configs.next_cursor && reads < 5; reads++) {
      if (seen.has(configs.next_cursor)) throw new ConnectorError('PROVIDER_INVALID_RESPONSE', 'The provider returned repeated auth configuration pages.', 502);
      seen.add(configs.next_cursor);
      const next = await listAuthConfigs(client, slug, configs.next_cursor);
      configs.items.push(...next.items); configs.next_cursor = next.next_cursor;
    }
    if (configs.next_cursor) throw new ConnectorError('AUTH_CONFIG_LIMIT', 'Too many auth configurations to safely display. Narrow the provider configuration first.', 422);
    if (new Set(configs.items.map(config => config.id)).size !== configs.items.length) {
      throw new ConnectorError('PROVIDER_INVALID_RESPONSE', 'The provider returned duplicate auth configurations.', 502);
    }
  }
  const connections = await projectConnections(siteId, userId, visible);
  return {
    toolkit: projectToolkit(toolkit, connections), connections,
    auth_configs: (configs?.items ?? []).map(config => ({ id: config.id, name: config.name, auth_scheme: config.authScheme ?? 'Unknown' })),
    can_create_managed_oauth: !!configs && !configs.items.some(config => config.authScheme === 'OAUTH2') && !!managedOAuthPreset(toolkit),
    auth_configs_next_cursor: configs?.next_cursor ?? null, can_manage: access.can_manage, credential_source: credential.source,
  };
}