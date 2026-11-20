import { z } from 'zod';

export const catalogPageNumber = z.coerce.number().int().min(1).max(100_000);

/** Composio's documented base64 page/limit cursor; never an authority token. */
export function catalogPageCursor(page: number, limit: number): string | undefined {
  catalogPageNumber.parse(page);
  return page === 1 ? undefined : Buffer.from(`${page}-${limit}`, 'utf8').toString('base64');
}

export function catalogPagination(page: number, limit: number, total: number | null, hasNext: boolean) {
  return { current_page: page, total_pages: total === null ? null : Math.max(1, Math.ceil(total / limit)),
    has_next: hasNext };
}