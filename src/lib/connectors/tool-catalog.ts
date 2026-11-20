import { z } from 'zod';
import { createComposioClient, type ComposioClient } from './composio-transport';
import { inputValue, opaqueCursor, toolkitSlug } from './composio-validation';
import { listToolkitToolMetadata, TOOL_CATALOG_LIMIT, toolSearchQuery } from './composio-tool-metadata';
import { loadConnectorCredential, requireConnectorSiteAccess } from './access';
import { REVIEWED_CONNECTOR_TOOLS } from './reviewed-tools';
import { catalogPageCursor, catalogPageNumber, catalogPagination } from './catalog-pagination';

export const toolCatalogQuery = z.object({ site_id: z.string().uuid(), cursor: opaqueCursor.optional(), page: catalogPageNumber.optional(), q: toolSearchQuery.optional() }).strict()
  .refine(query => !(query.cursor && query.page), 'Choose a page or cursor, not both');
/** Catalogue metadata only. Never expose schemas, credentials or execution authority. */
export async function listToolkitTools(client: ComposioClient, slug: string, cursor?: string, query?: string) {
  const page = await listToolkitToolMetadata(client, slug, cursor, query);
  return {
    ...page,
    items: page.items.map(tool => ({ ...tool,
      reviewed: REVIEWED_CONNECTOR_TOOLS.some(reviewed => reviewed.toolkit === slug && reviewed.slug === tool.slug) })),
  };
}

export async function getToolkitToolCatalog(userId: string, slug: string, input: z.infer<typeof toolCatalogQuery>) {
  const query = toolCatalogQuery.parse(input); inputValue(toolkitSlug, slug);
  await requireConnectorSiteAccess(query.site_id, userId);
  const credential = await loadConnectorCredential(query.site_id);
  const page = query.page ?? 1;
  const result = await listToolkitTools(createComposioClient(credential.apiKey), slug,
    query.page ? catalogPageCursor(page, TOOL_CATALOG_LIMIT) : query.cursor, query.q);
  return { ...result, ...catalogPagination(page, TOOL_CATALOG_LIMIT, result.total, !!result.next_cursor) };
}