import { catalogPageCursor, catalogPagination } from './catalog-pagination';
import { listToolkitToolMetadata, TOOL_CATALOG_LIMIT } from './composio-tool-metadata';
import { invalidProviderResponse, type ComposioClient } from './composio-transport';
import { filteredCatalogPage } from './filtered-catalog';
import type { ToolActionFilter } from './tool-action-types';
import { ConnectorError } from './types';

const MAX_SCAN_PAGES = 50;
const SCAN_BUDGET_MS = 12_000;

async function unclassifiedPage(client: ComposioClient, slug: string, page: number, query?: string) {
  // Composio supports positive tag filters only. Count and page the complement without returning partial results.
  const deadline = Date.now() + SCAN_BUDGET_MS;
  const cursors = new Set<string>();
  const slugs = new Set<string>();
  const items: Awaited<ReturnType<typeof listToolkitToolMetadata>>['items'] = [];
  const offset = (page - 1) * TOOL_CATALOG_LIMIT;
  let total = 0;
  let providerTotal: number | null = null;
  let cursor: string | undefined;
  do {
    const batch = await listToolkitToolMetadata(client, slug, cursor, query);
    if (Date.now() >= deadline) throw new ConnectorError('PROVIDER_TIMEOUT', 'The connector catalogue scan timed out.', 504);
    if (batch.total !== null) {
      if (providerTotal !== null && providerTotal !== batch.total) invalidProviderResponse();
      providerTotal = batch.total;
    }
    for (const tool of batch.items) {
      if (slugs.has(tool.slug)) invalidProviderResponse();
      slugs.add(tool.slug);
      if (tool.action_types.length) continue;
      if (total >= offset && items.length < TOOL_CATALOG_LIMIT) items.push(tool);
      total++;
    }
    cursor = batch.next_cursor ?? undefined;
    if (cursor) {
      if (cursors.has(cursor)) invalidProviderResponse();
      cursors.add(cursor);
      if (cursors.size >= MAX_SCAN_PAGES) throw new ConnectorError('CATALOG_LIMIT', 'The tool catalogue is too large to filter. Narrow your search and try again.', 422);
    }
  } while (cursor);
  if (providerTotal !== null && providerTotal !== slugs.size) invalidProviderResponse();
  const hasNext = offset + TOOL_CATALOG_LIMIT < total;
  return { items, total, next_cursor: hasNext ? `filtered:${page + 1}` : null,
    ...catalogPagination(page, TOOL_CATALOG_LIMIT, total, hasNext) };
}

export async function readToolkitToolsPage(client: ComposioClient, slug: string, input: {
  page?: number; cursor?: string; q?: string; action?: ToolActionFilter;
}) {
  const { page, cursor, q, action } = input;
  if (action === 'unclassified') return unclassifiedPage(client, slug, filteredCatalogPage(cursor, page), q);
  const number = page ?? 1;
  const result = await listToolkitToolMetadata(client, slug, page ? catalogPageCursor(page, TOOL_CATALOG_LIMIT) : cursor, q, action);
  return { ...result, ...catalogPagination(number, TOOL_CATALOG_LIMIT, result.total, !!result.next_cursor) };
}