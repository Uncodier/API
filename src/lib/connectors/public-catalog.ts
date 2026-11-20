import { unstable_cache } from 'next/cache';
import { z } from 'zod';
import { catalogPageCursor, catalogPagination } from './catalog-pagination';
import { getToolkit, type ComposioToolkit } from './composio-catalog';
import { listToolkitToolMetadata, TOOL_CATALOG_LIMIT } from './composio-tool-metadata';
import { createComposioClient } from './composio-transport';
import { toolkitSlug } from './composio-validation';
import { CONNECTOR_DOMAINS, getToolkitDomains } from './domains';
import { paginateFilteredCatalog, scanProviderCatalog } from './filtered-catalog';
import { ConnectorError } from './types';

const pageQuery = z.string().regex(/^[1-9][0-9]{0,2}$/).transform(Number).optional();
const domains = CONNECTOR_DOMAINS.map(({ id, label }) => ({ id, label }));
const catalogQuery = z.object({
  q: z.string().trim().max(200).regex(/^[^\u0000-\u001f\u007f]*$/).optional(),
  category: z.string().refine(value => domains.some(domain => domain.id === value)).optional(),
  page: pageQuery,
}).strict();
const toolsQuery = z.object({ page: pageQuery }).strict();
const detailQuery = z.object({}).strict();

function client() {
  // Only a server-side platform credential; never resolve credentials by site or user.
  return createComposioClient((process.env.COMPOSIO_PUBLIC_CATALOG_API_KEY || process.env.COMPOSIO_API_KEY || '').trim());
}

function project(toolkit: ComposioToolkit, maxDescription: number) {
  const { slug, name, description, logo_url, tools_count, categories } = toolkit;
  return { slug, name, description: description.slice(0, maxDescription), logo: logo_url, tools_count,
    domains: getToolkitDomains(slug, categories.flatMap(category => [category.slug, category.name])) };
}

// A single bounded snapshot serves every search/category/page combination. Public
// filters must not trigger an upstream catalogue scan per arbitrary query.
const snapshot = unstable_cache(async () => {
  const toolkits = await scanProviderCatalog(client());
  return toolkits.map(toolkit => project(toolkit, 320));
}, ['public-integration-catalog-v1'], { revalidate: 900 });

const toolkitDetail = unstable_cache(async (slug: string) => project(await getToolkit(client(), slug), 12_000),
  ['public-integration-detail-v1'], { revalidate: 900 });

const toolkitTools = unstable_cache(async (slug: string, page: number) => {
  const result = await listToolkitToolMetadata(client(), slug, catalogPageCursor(page, TOOL_CATALOG_LIMIT));
  return { items: result.items, total: result.total,
    ...catalogPagination(page, TOOL_CATALOG_LIMIT, result.total, !!result.next_cursor) };
}, ['public-integration-tools-v1'], { revalidate: 900 });

function queryParams(request: Request) {
  const query: Record<string, string> = Object.create(null);
  for (const [key, value] of new URL(request.url).searchParams) {
    if (!['q', 'page', 'category'].includes(key) || Object.hasOwn(query, key) || value.length > 200) {
      throw new ConnectorError('INVALID_REQUEST', 'Invalid catalogue query.', 400);
    }
    query[key] = value;
  }
  return query;
}

export async function publicCatalogResponse(request: Request, kind: 'list' | 'detail' | 'tools', slug?: string) {
  try {
    const query = queryParams(request);
    let data: unknown;
    if (kind === 'list') {
      const { q, category, page = 1 } = catalogQuery.parse(query);
      const search = q?.toLowerCase();
      const matches = (await snapshot()).filter(toolkit => (!category || toolkit.domains.includes(category))
        && (!search || `${toolkit.name} ${toolkit.slug} ${toolkit.description}`.toLowerCase().includes(search)));
      const { items, total, current_page, total_pages, has_next } = paginateFilteredCatalog(matches, page, 50);
      data = { items, total, current_page, total_pages, has_next, domains };
    } else {
      const id = toolkitSlug.parse(slug);
      if (kind === 'detail') {
        detailQuery.parse(query);
        data = { toolkit: await toolkitDetail(id), domains };
      } else {
        const { page = 1 } = toolsQuery.parse(query);
        // Verify the toolkit is native before listing tools. No custom project catalogue.
        await toolkitDetail(id);
        data = await toolkitTools(id, page);
      }
    }
    return Response.json(data, { headers: { 'Cache-Control': query.q ? 'no-store' : 'public, max-age=60, s-maxage=300' } });
  } catch (error) {
    const status = error instanceof z.ZodError || (error instanceof ConnectorError && error.code === 'INVALID_REQUEST') ? 400
      : error instanceof ConnectorError && error.code === 'PROVIDER_NOT_FOUND' && kind !== 'list' ? 404 : 503;
    return Response.json({ error: status === 400 ? 'INVALID_REQUEST' : status === 404 ? 'NOT_FOUND' : 'CATALOG_UNAVAILABLE' },
      { status, headers: { 'Cache-Control': 'no-store' } });
  }
}