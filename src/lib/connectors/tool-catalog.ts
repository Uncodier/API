import { z } from 'zod';
import { createComposioClient, type ComposioClient } from './composio-transport';
import { inputValue, opaqueCursor, toolkitSlug } from './composio-validation';
import { toolSearchQuery } from './composio-tool-metadata';
import { loadConnectorCredential, requireConnectorSiteAccess } from './access';
import { REVIEWED_CONNECTOR_TOOLS } from './reviewed-tools';
import { catalogPageNumber } from './catalog-pagination';
import { toolActionFilter } from './tool-action-types';
import { readToolkitToolsPage } from './tool-catalog-page';

export const toolCatalogQuery = z.object({
  site_id: z.string().uuid(), cursor: opaqueCursor.optional(), page: catalogPageNumber.optional(),
  q: toolSearchQuery.optional(), action: toolActionFilter.optional(),
}).strict()
  .refine(query => !(query.cursor && query.page), 'Choose a page or cursor, not both');
/** Catalogue metadata only. Never expose schemas, credentials or execution authority. */
export async function listToolkitTools(client: ComposioClient, slug: string, input: Parameters<typeof readToolkitToolsPage>[2] = {}) {
  const page = await readToolkitToolsPage(client, slug, input);
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
  return listToolkitTools(createComposioClient(credential.apiKey), slug, query);
}