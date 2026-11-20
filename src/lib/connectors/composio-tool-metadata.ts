import { z } from 'zod';
import { invalidProviderResponse, type ComposioClient } from './composio-transport';
import { inputValue, opaqueCursor, pageSchema, providerValue, safeText, toolkitSlug } from './composio-validation';
import { ConnectorError } from './types';

export const TOOL_CATALOG_LIMIT = 20;
export const catalogToolId = z.string().regex(/^[A-Z0-9][A-Z0-9_]{0,149}$/);
export const toolSearchQuery = z.string().max(200).regex(/^[^\u0000-\u001f\u007f]*$/).trim().min(1);
const metadata = z.object({
  slug: catalogToolId, name: safeText(300).min(1),
  description: safeText(32_000), toolkit: z.object({ slug: toolkitSlug }),
  is_deprecated: z.boolean(), deprecated: z.object({ is_deprecated: z.boolean().optional() }).nullish(),
});

function eligible(tool: z.infer<typeof metadata>, slug: string) {
  return tool.toolkit.slug === slug && !tool.is_deprecated && !tool.deprecated?.is_deprecated;
}

export async function listToolkitToolMetadata(client: ComposioClient, slug: string, cursor?: string, query?: string) {
  inputValue(toolkitSlug, slug);
  if (cursor !== undefined) inputValue(opaqueCursor, cursor);
  const params = new URLSearchParams({ toolkit_slug: slug, limit: String(TOOL_CATALOG_LIMIT), include_deprecated: 'false' });
  if (query !== undefined) params.set('query', inputValue(toolSearchQuery, query));
  if (cursor) params.set('cursor', cursor);
  const page = providerValue(pageSchema(metadata, TOOL_CATALOG_LIMIT), await client.request(`/tools?${params}`));
  if (page.items.some(tool => !eligible(tool, slug)) || new Set(page.items.map(tool => tool.slug)).size !== page.items.length
    || (cursor && page.next_cursor === cursor)) invalidProviderResponse();
  return {
    items: page.items.map(({ slug, name, description }) => ({ slug, name, description })),
    next_cursor: page.next_cursor ?? null, total: page.total_items ?? null,
  };
}

// tool_slugs overrides other provider filters. Verify every identity, toolkit and
// deprecation flag locally. Do not treat similar search hits as exact matches.
export async function validateCatalogToolIds(client: ComposioClient, slug: string, ids: string[]) {
  inputValue(toolkitSlug, slug);
  inputValue(z.array(catalogToolId).max(100).refine(list => new Set(list).size === list.length), ids);
  const batchSize = 12; // 12 * (150 chars + separator) fits the transport's 2048-char parameter limit.
  const deadline = Date.now() + 15_000;
  let retryAvailable = true; // One extra idempotent GET per save; never retry a mutation.
  const checkDeadline = () => {
    if (Date.now() >= deadline) throw new ConnectorError('PROVIDER_TIMEOUT', 'Catalogue validation timed out.', 504);
  };
  for (let offset = 0; offset < ids.length; offset += batchSize) {
    const batch = ids.slice(offset, offset + batchSize);
    const params = new URLSearchParams({ toolkit_slug: slug, include_deprecated: 'false', tool_slugs: batch.join(','), limit: String(batch.length) });
    const read = () => { checkDeadline(); return client.request(`/tools?${params}`); };
    let response: unknown;
    try { response = await read(); } catch (error) {
      if (!retryAvailable || !(error instanceof ConnectorError) || !['PROVIDER_UNAVAILABLE', 'PROVIDER_TIMEOUT'].includes(error.code)) throw error;
      retryAvailable = false;
      await new Promise(resolve => setTimeout(resolve, 150));
      response = await read();
    }
    checkDeadline();
    const page = providerValue(pageSchema(metadata, batchSize), response);
    const found = new Set(page.items.map(tool => tool.slug));
    if (page.next_cursor || (page.total_items !== undefined && page.total_items !== page.items.length)
      || found.size !== page.items.length || page.items.some(tool => !batch.includes(tool.slug))) invalidProviderResponse();
    if (found.size !== batch.length || page.items.some(tool => !eligible(tool, slug))) {
      throw new ConnectorError('TOOL_NOT_IN_CATALOG', 'An action is not in this toolkit’s current catalogue. Reload your selection.', 422);
    }
  }
}
