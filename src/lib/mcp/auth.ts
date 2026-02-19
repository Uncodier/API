/**
 * MCP HTTP API key validation.
 * Uses the same API keys as middleware: SERVICE_API_KEY (env) or keys from DB via ApiKeyService.
 */

import { ApiKeyService } from '@/lib/services/api-keys/ApiKeyService';

/**
 * Extracts API key from request (same as middleware: X-API-Key or Authorization: Bearer <key> only).
 * Only the Bearer scheme is accepted for Authorization; other schemes are ignored.
 */
export function getApiKeyFromRequest(request: Request): string | null {
  const xKey = request.headers.get('x-api-key');
  if (xKey) return xKey.trim();
  const auth = request.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  return null;
}

/**
 * Validates the request API key against SERVICE_API_KEY (env) or DB (ApiKeyService).
 * Same logic as middleware apiKeyAuth.
 */
export async function validateMcpApiKey(request: Request): Promise<boolean> {
  const apiKey = getApiKeyFromRequest(request);
  if (!apiKey) return false;

  const serviceApiKey = process.env.SERVICE_API_KEY;
  if (serviceApiKey && apiKey === serviceApiKey) return true;

  const { isValid } = await ApiKeyService.validateApiKey(apiKey);
  return isValid;
}
