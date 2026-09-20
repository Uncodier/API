import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiKeyService } from '@/lib/services/api-keys/ApiKeyService';
import { createSupabaseClient } from '@/lib/database/supabase-server';

const createApiKeySchema = z.object({
  name: z.string().min(1).max(200),
  scopes: z.array(z.string().min(1).max(100)).min(1).max(100),
  site_id: z.string().uuid().optional().nullable(),
  user_id: z.string().uuid().optional(),
  expirationDays: z.number().int().min(1).max(365).optional().default(90),
  prefix: z.string().regex(/^[a-zA-Z0-9-]{1,8}$/).optional(),
  metadata: z.record(z.any()).optional(),
});

function error(code: string, message: string, status: number, details?: unknown) {
  return NextResponse.json(
    { success: false, error: { code, message, details } },
    { status },
  );
}

function trustedUserId(
  request: NextRequest,
  requestedUserId?: string | null,
): string | null {
  const authenticatedUserId = request.headers.get('x-auth-user-id');
  if (authenticatedUserId) {
    return !requestedUserId || requestedUserId === authenticatedUserId
      ? authenticatedUserId
      : null;
  }

  const rawKeyData = request.headers.get('x-api-key-data');
  if (!rawKeyData) return null;
  try {
    const keyData = JSON.parse(rawKeyData) as {
      isService?: boolean;
      user_id?: string;
    };
    if (keyData.isService) return requestedUserId || null;
    if (
      keyData.user_id
      && (!requestedUserId || requestedUserId === keyData.user_id)
    ) {
      return keyData.user_id;
    }
  } catch {
    return null;
  }
  return null;
}

async function hasDirectSiteAccess(
  request: NextRequest,
  userId: string,
  siteId: string,
): Promise<boolean> {
  const supabase = createSupabaseClient(request);
  const { data, error: queryError } = await supabase
    .from('sites')
    .select('id')
    .eq('id', siteId)
    .eq('user_id', userId)
    .maybeSingle();
  return !queryError && Boolean(data);
}

export async function POST(request: NextRequest) {
  try {
    const parsed = createApiKeySchema.safeParse(await request.json());
    if (!parsed.success) {
      return error('INVALID_REQUEST', 'Invalid request parameters', 400, parsed.error.format());
    }
    const userId = trustedUserId(request, parsed.data.user_id);
    if (!userId) return error('UNAUTHORIZED', 'Authentication is required', 401);
    if (
      parsed.data.site_id
      && !await hasDirectSiteAccess(request, userId, parsed.data.site_id)
    ) {
      return error('FORBIDDEN', 'You do not have access to this site', 403);
    }
    if (!process.env.ENCRYPTION_KEY) {
      return error('CONFIGURATION_ERROR', 'Server configuration error', 500);
    }

    const apiKey = await ApiKeyService.createApiKey(
      userId,
      parsed.data,
      { client: createSupabaseClient(request) },
    );
    return NextResponse.json({ success: true, data: apiKey });
  } catch (cause) {
    console.error('[Keys API] Creation failed:', cause);
    return error(
      'SYSTEM_ERROR',
      cause instanceof Error ? cause.message : 'Unable to create API key',
      500,
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const siteId = searchParams.get('site_id');
    const userId = trustedUserId(request, searchParams.get('user_id'));
    if (!userId) return error('UNAUTHORIZED', 'Authentication is required', 401);
    if (!siteId) return error('INVALID_REQUEST', 'site_id is required', 400);
    if (!await hasDirectSiteAccess(request, userId, siteId)) {
      return error('FORBIDDEN', 'You do not have access to this site', 403);
    }
    const apiKeys = await ApiKeyService.listApiKeys(userId, siteId);
    return NextResponse.json({ success: true, data: apiKeys });
  } catch (cause) {
    console.error('[Keys API] Listing failed:', cause);
    return error(
      'SYSTEM_ERROR',
      cause instanceof Error ? cause.message : 'Unable to list API keys',
      500,
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const keyId = searchParams.get('id');
    const siteId = searchParams.get('site_id');
    const userId = trustedUserId(request, searchParams.get('user_id'));
    if (!userId) return error('UNAUTHORIZED', 'Authentication is required', 401);
    if (!keyId || !siteId) {
      return error('INVALID_REQUEST', 'API key ID and site_id are required', 400);
    }
    if (!await hasDirectSiteAccess(request, userId, siteId)) {
      return error('FORBIDDEN', 'You do not have access to this site', 403);
    }
    const revoked = await ApiKeyService.revokeApiKey(userId, keyId, siteId);
    if (!revoked) {
      return error('NOT_FOUND', 'API key not found or already revoked', 404);
    }
    return NextResponse.json({
      success: true,
      message: 'API key revoked successfully',
    });
  } catch (cause) {
    console.error('[Keys API] Revocation failed:', cause);
    return error(
      'SYSTEM_ERROR',
      cause instanceof Error ? cause.message : 'Unable to revoke API key',
      500,
    );
  }
}
