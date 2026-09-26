import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { canAccessSite } from '@/lib/security/site-access';
import { hasAuthenticatedPrincipal } from '@/lib/security/request-rate-limit';
import { SkillCatalogError, skillSiteIdSchema } from '@/lib/services/site-skills-catalog';
import { isSiteSkillManager } from '@/lib/services/site-skill-access';

export const skillBodySchema = z.object({
  site_id: skillSiteIdSchema,
  content: z.string().min(1).max(131072),
});
export const updateSkillBodySchema = z.object({
  site_id: skillSiteIdSchema,
  content: z.string().min(1).max(131072).optional(),
  enabled: z.boolean().optional(),
}).refine(value => value.content !== undefined || value.enabled !== undefined);
export const externalBodySchema = z.object({ site_id: skillSiteIdSchema, url: z.string().min(1).max(2048) });
export const importBodySchema = externalBodySchema.extend({ sha256: z.string().regex(/^[a-f0-9]{64}$/) });

export function failure(code: string, status: number, message: string) {
  return NextResponse.json({ success: false, error: { code, message } }, { status });
}

export async function requireSkillSite(request: NextRequest, siteId: string): Promise<NextResponse | null> {
  if (!hasAuthenticatedPrincipal(request)) return failure('unauthorized', 401, 'Authentication is required');
  if (!skillSiteIdSchema.safeParse(siteId).success) return failure('invalid_request', 400, 'Invalid site_id');
  if (!await canAccessSite(request, siteId)) return failure('forbidden', 403, 'Site access is required');
  return null;
}

/** Writes must be authorized here, not merely in the frontend BFF. Middleware verifies these headers. */
export async function requireSkillSiteManager(request: NextRequest, siteId: string): Promise<NextResponse | null> {
  if (request.headers.get('x-auth-validated') !== 'true') return failure('unauthorized', 401, 'User authentication is required');
  const userId = request.headers.get('x-auth-user-id');
  if (!userId || !z.string().uuid().safeParse(userId).success) return failure('unauthorized', 401, 'User authentication is required');
  if (!skillSiteIdSchema.safeParse(siteId).success) return failure('invalid_request', 400, 'Invalid site_id');
  return await isSiteSkillManager(siteId, userId)
    ? null : failure('forbidden', 403, 'Site manager access is required');
}

export async function parseSkillJson(request: NextRequest): Promise<unknown> {
  // A hard cap before JSON decoding protects against oversized HTTP request bodies.
  if (Number(request.headers.get('content-length')) > 150000) {
    throw new SkillCatalogError('invalid_request', 413, 'Request body is too large');
  }
  let size = 0;
  const reader = request.body?.getReader();
  if (!reader) throw new SkillCatalogError('invalid_request', 400, 'JSON body is required');
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 150000) throw new SkillCatalogError('invalid_request', 413, 'Request body is too large');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof SkillCatalogError) throw error;
    throw new SkillCatalogError('invalid_request', 400, 'Invalid JSON body');
  } finally { await reader.cancel().catch(() => {}); }
}

export function skillRouteError(error: unknown) {
  if (error instanceof SkillCatalogError) return failure(error.code, error.status, error.message);
  if (error instanceof z.ZodError) return failure('invalid_request', 400, 'Invalid request parameters');
  // Do not log errors: database/network errors may accidentally include skill content or tokens.
  return failure('internal_error', 500, 'Unable to process skill request');
}