import { catalogPageCursor, catalogPagination } from './catalog-pagination';
import { getToolkit, listToolkits, type ComposioToolkit } from './composio-catalog';
import type { ComposioClient } from './composio-transport';
import { ConnectorError } from './types';

const PROVIDER_LIMIT = 100;
const MAX_PROVIDER_PAGES = 50;
const CONCURRENCY = 5;
const SCAN_BUDGET_MS = 15_000;

function checkDeadline(deadline: number) {
  if (Date.now() >= deadline) throw new ConnectorError('PROVIDER_TIMEOUT', 'The connector catalogue scan timed out.', 504);
}

function catalogueLimit(): never {
  throw new ConnectorError('CATALOG_LIMIT', 'The connector catalogue is too large to filter. Narrow your search and try again.', 422);
}

export async function scanProviderCatalog(client: ComposioClient, query?: string) {
  const deadline = Date.now() + SCAN_BUDGET_MS;
  const read = (cursor?: string) => listToolkits(client, { query, cursor, limit: PROVIDER_LIMIT });
  const first = await read();
  const items = [...first.items];
  const totalPages = first.total_items === null ? null : Math.ceil(first.total_items / PROVIDER_LIMIT);
  // Only jump in parallel when the first continuation confirms the provider's numbered cursor format.
  if (first.next_cursor && first.next_cursor === catalogPageCursor(2, PROVIDER_LIMIT) && totalPages !== null && totalPages > 1) {
    if (totalPages > MAX_PROVIDER_PAGES) catalogueLimit();
    for (let start = 2; start <= totalPages; start += CONCURRENCY) {
      checkDeadline(deadline);
      const pages = await Promise.all(Array.from({ length: Math.min(CONCURRENCY, totalPages - start + 1) }, (_, i) =>
        read(catalogPageCursor(start + i, PROVIDER_LIMIT))));
      for (const [index, page] of pages.entries()) {
        const number = start + index;
        const expected = number < totalPages ? catalogPageCursor(number + 1, PROVIDER_LIMIT) : null;
        if (page.next_cursor !== expected || page.total_items !== first.total_items) {
          throw new ConnectorError('PROVIDER_INVALID_RESPONSE', 'The provider catalogue changed while filtering. Please retry.', 502);
        }
        items.push(...page.items);
      }
    }
  } else {
    const seen = new Set<string>();
    let cursor = first.next_cursor;
    while (cursor) {
      if (seen.has(cursor)) throw new ConnectorError('PROVIDER_INVALID_RESPONSE', 'The provider returned a repeated catalogue cursor.', 502);
      if (seen.size >= MAX_PROVIDER_PAGES - 1) catalogueLimit();
      checkDeadline(deadline);
      seen.add(cursor);
      const page = await read(cursor);
      items.push(...page.items);
      cursor = page.next_cursor;
    }
  }
  checkDeadline(deadline);
  return [...new Map(items.map(toolkit => [toolkit.slug, toolkit])).values()];
}

export async function scanConnectedCatalog(client: ComposioClient, slugs: string[]) {
  const deadline = Date.now() + SCAN_BUDGET_MS;
  const items: ComposioToolkit[] = [];
  for (let start = 0; start < slugs.length; start += CONCURRENCY) {
    checkDeadline(deadline);
    items.push(...await Promise.all(slugs.slice(start, start + CONCURRENCY).map(slug => getToolkit(client, slug))));
  }
  checkDeadline(deadline);
  return items;
}

export function filteredCatalogPage(cursor: string | undefined, page: number | undefined) {
  if (!cursor) return page ?? 1;
  const match = /^filtered:([1-9][0-9]{0,5})$/.exec(cursor);
  if (!match || Number(match[1]) > 100_000) throw new ConnectorError('INVALID_REQUEST', 'Invalid filtered catalogue cursor.', 400);
  return Number(match[1]);
}

export function paginateFilteredCatalog<T>(items: T[], page: number, limit: number) {
  const offset = (page - 1) * limit;
  const hasNext = offset + limit < items.length;
  return {
    items: items.slice(offset, offset + limit), total: items.length,
    next_cursor: hasNext ? `filtered:${page + 1}` : null,
    ...catalogPagination(page, limit, items.length, hasNext),
  };
}