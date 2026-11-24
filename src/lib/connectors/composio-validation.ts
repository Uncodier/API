import { z } from 'zod';
import { invalidInput, invalidProviderResponse } from './composio-transport';

export const providerId = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
export const toolkitSlug = z.string().regex(/^[a-z0-9_][a-z0-9_-]{0,99}$/);
export const toolSlug = z.string().regex(/^[A-Z0-9_]{1,150}$/).refine(value => !value.startsWith('COMPOSIO_'));
export const safeText = (max: number) => z.string().max(max).regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/);
export const opaqueCursor = z.string().min(1).max(2048).regex(/^[^\u0000-\u0020\u007f]+$/);
export const scopesSchema = z.array(safeText(2048).min(1)).max(256);

export function providerValue<T>(schema: z.ZodType<T>, value: unknown, write = false): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) invalidProviderResponse(write);
  return parsed.data;
}

export function inputValue<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) invalidInput();
  return parsed.data;
}

export function pageSchema<T extends z.ZodTypeAny>(item: T, max = 100) {
  return z.object({
    items: z.array(item).max(max), next_cursor: opaqueCursor.nullish(),
    total_items: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  });
}

/** No URL is fetched here. Logo rendering is constrained to provider-owned public hosts. */
export function safeLogo(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return null;
    if (!['logos.composio.dev', 'cdn.composio.dev', 'assets.composio.dev'].includes(url.hostname)) return null;
    return url.toString();
  } catch { return null; }
}