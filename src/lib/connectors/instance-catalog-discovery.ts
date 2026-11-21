import { createHash } from 'node:crypto';
import type { ToolScreenAccess } from '@/app/api/agents/tools/router/screen-access';
import { loadConnectorCredential } from './access';
import { catalogPageCursor } from './catalog-pagination';
import { listSelectedCatalogMetadata, listToolkitToolMetadata, TOOL_CATALOG_LIMIT } from './composio-tool-metadata';
import { createComposioClient } from './composio-transport';
import { CONNECTOR_DOMAINS, getToolkitDomains } from './domains';
import { connectorToolRef, REVIEWED_CONNECTOR_TOOLS } from './reviewed-tools';
import type { ConnectorCandidate, ConnectorFilters } from './runtime';
import { ConnectorError, type AuthorizedConnector, type ConnectorContext } from './types';

const PAGE_SIZE = 5;
const REPORT = 'SUPABASE_RUN_READ_ONLY_QUERY';
const reportDescription = 'Calculate figures with a direct read-only SELECT on authorized analytics sources, or list published reports. Describe this tool to see queryable sources and scopes.';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const stale = () => new ConnectorError('STALE_CURSOR', 'Connector inventory changed. Restart the search without its cursor.', 409);

export function catalogInstance(context: ConnectorContext) {
  return context.host === 'assistant' && context.catalogUserSession === true && Boolean(context.instanceId && context.agentId && context.userId);
}
export function catalogScreens(access: ToolScreenAccess | null) {
  // A dynamic toolkit has no trusted mapping to one business screen.
  return !!access && (access.isAdmin || access.blockedScreens.length === 0);
}
export function catalogGrant(target: AuthorizedConnector, slug?: string) {
  return target.policy.catalog_reads === true && !target.requestOnly &&
    (target.policy.tool_access_mode === 'all' || (slug ? target.policy.allowed_tools.includes(slug) : target.policy.allowed_tools.length > 0));
}
export function catalogDefinition(slug: string, toolkit: string) {
  const domains = getToolkitDomains(toolkit);
  const category = CONNECTOR_DOMAINS.find(d => d.id === domains[0])?.categories[0] ?? 'other';
  return { slug, toolkit, domains, category, requiredScreens: [], requiredScopes: [], description:
    toolkit === 'supabase' && slug === REPORT ? reportDescription : `Provider catalog action: ${slug}. Inspect its validated contract before use.` };
}

// Only server-owned public vocabulary may leave the site. Other search terms (including exact
// slugs) match provider metadata locally, page by page; slug-shaped text can still be a secret.
const providerTerms = /\b(?:labels|calendars|companies|contacts|customers|deals|projects|issues|reports|tables|tickets|tasks|orders|messages|events|folders)\b/g;
function publicQuery(toolkit: string, text: string) {
  if (toolkit === 'supabase' && (text.trim().toUpperCase() === REPORT ||
      /\b(reports?|reportes?|informes?|reporting|aggregates?|agregados?|analytics|sql|select|kpis?|ventas|licitaciones|compras|sales|tenders)\b/i.test(text))) return REPORT;
  return text.toLowerCase().match(providerTerms)?.[0];
}
function localMatch(toolkit: string, item: Awaited<ReturnType<typeof listToolkitToolMetadata>>['items'][number], query?: string) {
  if (!query) return true;
  if (/^[A-Z0-9]+(?:_[A-Z0-9]+)+$/.test(query)) return query === item.slug;
  // Apply the same server-owned alias on both sides of the provider round trip.
  if (toolkit === 'supabase' && item.slug === REPORT && publicQuery(toolkit, query) === REPORT) return true;
  const words = query.toLowerCase().split(/[ _-]+/).filter(Boolean);
  const summary = `${item.name} ${item.slug} ${item.description}`.toLowerCase();
  return words.every(word => summary.includes(word));
}
function catalogRow(target: AuthorizedConnector, item: Awaited<ReturnType<typeof listToolkitToolMetadata>>['items'][number]): ConnectorCandidate | null {
  if (!catalogGrant(target, item.slug) || item.slug.startsWith('COMPOSIO_') || !/^[A-Z0-9][A-Z0-9_]{0,149}$/.test(item.slug) ||
    REVIEWED_CONNECTOR_TOOLS.some(t => t.slug === item.slug)) return null;
  const toolkit = target.connector.toolkit_slug;
  const report = toolkit === 'supabase' && item.slug === REPORT;
  const read = item.action_types.length === 1 && item.action_types[0] === 'read';
  const definition = catalogDefinition(item.slug, toolkit);
  // Catalog metadata is never a grant. Even read candidates need a fresh descriptor.
  return { name: connectorToolRef(target.connector.id, item.slug), description: definition.description,
    domains: definition.domains, category: definition.category, connector_id: target.connector.id, toolkit,
    availability: report || (read && toolkit !== 'supabase') ? 'describe_required' : 'manual_only' };
}

async function accountPage(client: ReturnType<typeof createComposioClient>, target: AuthorizedConnector, page: number, query?: string) {
  const kit = target.connector.toolkit_slug;
  const { tool_access_mode, allowed_tools } = target.policy;
  if (tool_access_mode !== 'selected' || (query && !allowed_tools.includes(query))) {
    return { ...await listToolkitToolMetadata(client, kit, catalogPageCursor(page, TOOL_CATALOG_LIMIT), query), missing: false };
  }
  // Do not scan the entire toolkit to locate one saved ID. Composio's tool_slugs filter is bounded to 12 here.
  const selected = [...new Set(query ? [query] : allowed_tools)].filter(slug => !slug.startsWith('COMPOSIO_') && !REVIEWED_CONNECTOR_TOOLS.some(t => t.slug === slug)).sort();
  const batch = selected.slice((page - 1) * 12, page * 12);
  const result = batch.length ? await listSelectedCatalogMetadata(client, kit, batch) : { items: [], missing: false };
  return { ...result, next_cursor: selected.length > page * 12 };
}

/** One bounded catalog GET per page, not per authorized account. Cursors grant no rights. */
export async function instanceCatalogPage(context: ConnectorContext, filters: ConnectorFilters, reviewed: ConnectorCandidate[],
  targets: AuthorizedConnector[], access: ToolScreenAccess | null) {
  if (filters.catalog_query !== undefined && (typeof filters.catalog_query !== 'string' || !/^[a-z\d][a-z\d_ -]{0,149}$/i.test(filters.catalog_query))) {
    throw new ConnectorError('INVALID_FILTER', 'Use public tool keywords or an exact provider slug in catalog_query.', 400);
  }
  const accounts = !catalogInstance(context) || !catalogScreens(access) ? [] : targets.filter(target => {
    const { domains, category } = catalogDefinition('', target.connector.toolkit_slug);
    return catalogGrant(target) && (!filters.connector_id || filters.connector_id === target.connector.id) &&
      (!filters.domain || domains.includes(filters.domain)) && (!filters.category || category === filters.category);
  }).sort((a, b) => a.connector.id.localeCompare(b.connector.id));
  const key = digest([context, filters.query, filters.catalog_query, filters.domain, filters.category, filters.connector_id, reviewed.map(r => [r.name, r.request_only]),
    accounts.map(({ connector, policy, provider }) => [connector.id, connector.revision, policy.revision, provider.credential_revision])]);
  let local = 0, account = 0, page = 1, offset = 0, fingerprint = '';
  if (filters.cursor) {
    const m = /^c1:([a-f0-9]{24}):(\d{1,5}):(\d{1,4}):(\d{1,6}):(\d{1,2}):(-|[a-f0-9]{24})$/.exec(filters.cursor);
    if (!m || m[1] !== key) throw stale();
    [local, account, page, offset] = m.slice(2, 6).map(Number); fingerprint = m[6] === '-' ? '' : m[6];
    if (local > reviewed.length || account > accounts.length || page < 1 || page > 100_000 || offset >= TOOL_CATALOG_LIMIT || Boolean(offset) !== Boolean(fingerprint)) throw stale();
  }
  const tools = reviewed.slice(local, local + (account < accounts.length ? 2 : PAGE_SIZE)); local += tools.length;
  let partialError: string | undefined;
  if (account < accounts.length) {
    const target = accounts[account];
    try {
      const credential = await loadConnectorCredential(context.siteId);
      if (credential.revision !== target.provider.credential_revision) throw new ConnectorError('STALE_CREDENTIAL', 'Connection verification changed.', 409);
      const result = await accountPage(createComposioClient(credential.apiKey), target, page, publicQuery(target.connector.toolkit_slug, filters.catalog_query || filters.query || ''));
      if (result.missing) partialError = 'CATALOG_SELECTION_CHANGED';
      const current = digest(result.items.map(i => [i.slug, i.action_types]));
      if (offset && (fingerprint !== current || offset >= result.items.length)) throw stale();
      for (; offset < result.items.length && tools.length < PAGE_SIZE; offset++) {
        if (!localMatch(target.connector.toolkit_slug, result.items[offset], filters.catalog_query)) continue;
        const row = catalogRow(target, result.items[offset]);
        if (row) tools.push(row);
      }
      if (offset < result.items.length) fingerprint = current;
      else {
        offset = 0; fingerprint = '';
        if (result.next_cursor && page < 100_000) page++;
        else { account++; page = 1; }
      }
    } catch (error) {
      if (!(error instanceof ConnectorError) || error.code === 'STALE_CURSOR') throw error;
      // A failed account is not a negative permission; retain native/curated results and avoid loops.
      partialError = error.code; account++; page = 1; offset = 0; fingerprint = '';
    }
  }
  const more = local < reviewed.length || account < accounts.length;
  return { tools, truncated: more, next_cursor: more ? `c1:${key}:${local}:${account}:${page}:${offset}:${fingerprint || '-'}` : null,
    ...(partialError && { partial_error: partialError }) };
}
