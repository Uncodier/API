import { NextRequest, NextResponse } from 'next/server';
import { ApiKeyService } from '@/lib/services/api-keys/ApiKeyService';
import { getScopeDescriptor, hasScope } from './scopes-catalog';
import { logPlatformCall } from './platform-audit-log';
import { reserveQuota, type QuotaDecision } from './platform-quota';

export interface PlatformRequestContext {
  site_id: string;
  requirement_id: string | null;
  api_key_id: string;
  scopes: string[];
  test_only: boolean;
  capability: string;
  scope: string;
}

export interface PlatformHandlerResult {
  status: number;
  body: any;
  cost_units?: number;
  response_summary?: Record<string, any>;
}

export type PlatformHandler = (
  req: NextRequest,
  ctx: PlatformRequestContext,
) => Promise<PlatformHandlerResult>;

function extractBearer(req: NextRequest): string | null {
  const header = req.headers.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  return match[1].trim();
}

async function validateKey(token: string): Promise<{
  valid: boolean;
  key_id?: string;
  site_id?: string;
  scopes?: string[];
  metadata?: Record<string, any>;
  requirement_id?: string | null;
}> {
  try {
    const result = await ApiKeyService.validateApiKey(token);
    if (!result.isValid || !result.keyData) return { valid: false };
    const kd = result.keyData as any;
    return {
      valid: true,
      key_id: kd.id,
      site_id: kd.site_id,
      scopes: Array.isArray(kd.scopes) ? kd.scopes : [],
      metadata: (kd.metadata ?? {}) as Record<string, any>,
      requirement_id: (kd.metadata?.requirement_id as string | undefined) ?? null,
    };
  } catch {
    return { valid: false };
  }
}

/**
 * Wraps a Platform API handler with auth, scope, quota and audit. The handler
 * is invoked only after the bearer token validates and the scope check passes.
 * Every call — approved or rejected — flows through `logPlatformCall`.
 */
export function withPlatformScope(params: {
  scope: string;
  endpoint: string;
  handler: PlatformHandler;
  /** Optional cost override; defaults to 1 token per call. */
  cost?: (req: NextRequest) => number | Promise<number>;
}) {
  const descriptor = getScopeDescriptor(params.scope);
  if (!descriptor) {
    throw new Error(`[Platform] Unknown scope "${params.scope}" — register in scopes-catalog.ts.`);
  }
  return async (req: NextRequest): Promise<NextResponse> => {
    const started = Date.now();
    const token = extractBearer(req);
    if (!token) {
      await logPlatformCall({
        site_id: 'unknown',
        endpoint: params.endpoint,
        method: req.method,
        status: 401,
        error: 'missing bearer token',
        capability: descriptor.capability,
      });
      return NextResponse.json({ error: 'Missing bearer token' }, { status: 401 });
    }

    const key = await validateKey(token);
    if (!key.valid || !key.site_id || !key.key_id) {
      await logPlatformCall({
        site_id: 'unknown',
        endpoint: params.endpoint,
        method: req.method,
        status: 401,
        error: 'invalid api key',
        capability: descriptor.capability,
      });
      return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
    }

    if (!hasScope(key.scopes ?? [], params.scope)) {
      await logPlatformCall({
        site_id: key.site_id,
        requirement_id: key.requirement_id,
        api_key_id: key.key_id,
        endpoint: params.endpoint,
        method: req.method,
        status: 403,
        scope: params.scope,
        capability: descriptor.capability,
        error: `missing scope ${params.scope}`,
        latency_ms: Date.now() - started,
      });
      return NextResponse.json(
        { error: `Missing scope "${params.scope}". Available scopes: ${(key.scopes ?? []).join(', ') || 'none'}` },
        { status: 403 },
      );
    }

    const cost = params.cost ? Math.max(1, Math.round(await params.cost(req))) : 1;
    const quota: QuotaDecision = await reserveQuota({
      site_id: key.site_id,
      capability: descriptor.capability,
      cost,
    });
    if (!quota.allowed) {
      await logPlatformCall({
        site_id: key.site_id,
        requirement_id: key.requirement_id,
        api_key_id: key.key_id,
        endpoint: params.endpoint,
        method: req.method,
        status: 429,
        scope: params.scope,
        capability: descriptor.capability,
        error: quota.reason,
        latency_ms: Date.now() - started,
      });
      return NextResponse.json({ error: quota.reason, used: quota.used, limit: quota.limit }, { status: 429 });
    }

    const ctx: PlatformRequestContext = {
      site_id: key.site_id,
      requirement_id: key.requirement_id ?? null,
      api_key_id: key.key_id,
      scopes: key.scopes ?? [],
      test_only: descriptor.test_only,
      capability: descriptor.capability,
      scope: params.scope,
    };

    try {
      const res = await params.handler(req, ctx);
      const resp = NextResponse.json(res.body, { status: res.status });
      if (quota.softWarn) {
        resp.headers.set('X-Quota-Warning', `approaching limit: used=${quota.used}/${quota.limit}`);
      }
      if (ctx.test_only) {
        resp.headers.set('X-Test-Only', 'true');
      }
      await logPlatformCall({
        site_id: ctx.site_id,
        requirement_id: ctx.requirement_id,
        api_key_id: ctx.api_key_id,
        endpoint: params.endpoint,
        method: req.method,
        status: res.status,
        scope: params.scope,
        capability: descriptor.capability,
        cost_units: res.cost_units ?? cost,
        latency_ms: Date.now() - started,
        test_only: ctx.test_only,
        response_summary: res.response_summary,
      });
      return resp;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'unknown handler error';
      await logPlatformCall({
        site_id: ctx.site_id,
        requirement_id: ctx.requirement_id,
        api_key_id: ctx.api_key_id,
        endpoint: params.endpoint,
        method: req.method,
        status: 500,
        scope: params.scope,
        capability: descriptor.capability,
        latency_ms: Date.now() - started,
        test_only: ctx.test_only,
        error: msg,
      });
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  };
}
