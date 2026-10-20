import { z } from 'zod';
import { CatalogAuthorizationError, requireCatalogService } from './auth';
import { CatalogBodyTooLargeError, readCatalogJson } from './request-body';

export async function catalogIndexRequest<T extends z.ZodTypeAny>(request: Request, schema: T, execute: (input: z.output<T>) => Promise<unknown>) {
  try {
    await requireCatalogService(request);
    const input = schema.parse(await readCatalogJson(request, 4_096));
    return Response.json(await execute(input), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof CatalogAuthorizationError ? error.status
      : error instanceof CatalogBodyTooLargeError ? 413
      : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 503;
    return Response.json({ success: false, error: 'Catalog indexing request failed' },
      { status, headers: { 'Cache-Control': 'no-store' } });
  }
}