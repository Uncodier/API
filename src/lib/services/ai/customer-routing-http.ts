import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { rolloutEnabled } from '@/lib/integrations/openrouter/types';
import { resolveToolRequestPrincipal, canToolPrincipalAccessSite } from '@/lib/security/tool-request-principal';
import { CustomerRoutingError, getExecutionRouting, resolveExecutionRouting, withExecutionRouting,
  getCustomerCapability, getCustomerOperationKey, withCustomerCapability,
  withCustomerOperation, type ExecutionRoutingReference } from './customer-routing';

const HEADER = 'x-host-inference-routing';
type Ticket = { routing: ExecutionRoutingReference; path: string; operationId: string; expires: number; capability?: 'summary' };
function key(): string {
  const value = process.env.SERVICE_API_KEY?.trim();
  if (!value) throw new CustomerRoutingError('INTERNAL_ROUTING_AUTH_UNAVAILABLE');
  return value;
}
function signature(payload: string): Buffer {
  return createHmac('sha256', key()).update(`customer-routing-v1:${payload}`).digest();
}

/** Called by authenticated host execution only. Never sign a reference from request JSON. */
export async function executionRoutingHeaders(routing: ExecutionRoutingReference,
  options: { path: string; operationId?: string }): Promise<Record<string, string>> {
  if (!options.path.startsWith('/api/') || options.path.includes('?') || !routing.siteId) {
    throw new CustomerRoutingError('INVALID_ROUTING_TARGET');
  }
  const active = getExecutionRouting(routing.siteId);
  if (active && JSON.stringify(active) !== JSON.stringify(routing)) throw new CustomerRoutingError('ROUTING_CHILD_REBIND_FORBIDDEN');
  const payload = Buffer.from(JSON.stringify({ routing, path: options.path,
    operationId: options.operationId ?? getCustomerOperationKey() ?? randomUUID(), expires: Date.now() + 300_000,
    ...(getCustomerCapability() === 'summary' ? { capability: 'summary' as const } : {}),
  } satisfies Ticket)).toString('base64url');
  return { [HEADER]: `${payload}.${signature(payload).toString('base64url')}` };
}

function ticket(request: Request, siteId: string): Ticket | undefined {
  const header = request.headers.get(HEADER);
  if (!header) return undefined;
  try {
    if (header.length > 4096) throw new Error();
    const [payload, encoded, extra] = header.split('.');
    const actual = Buffer.from(encoded, 'base64url'), expected = signature(payload);
    if (extra || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Ticket;
    if (parsed.path !== new URL(request.url).pathname || parsed.routing.siteId !== siteId ||
      !Number.isSafeInteger(parsed.expires) || parsed.expires <= Date.now() || parsed.expires > Date.now() + 300_000 ||
      typeof parsed.operationId !== 'string' || !parsed.operationId || parsed.operationId.length > 256 ||
      (parsed.capability !== undefined && parsed.capability !== 'summary')) throw new Error();
    return parsed;
  } catch { throw new CustomerRoutingError('INVALID_INTERNAL_ROUTING_TICKET'); }
}

/** The receiving route authenticates credentials and site access independently. */
export async function resolveHttpExecutionRouting(request: Request, authorizedSiteId: string): Promise<ExecutionRoutingReference> {
  const pin = ticket(request, authorizedSiteId);
  return pin?.routing ?? (rolloutEnabled() ? await resolveExecutionRouting(authorizedSiteId)
    : { payer: 'platform', siteId: authorizedSiteId });
}

export async function withHttpExecutionRouting<T>(request: Request, routing: ExecutionRoutingReference,
  operation: () => Promise<T>): Promise<T> {
  const pin = ticket(request, routing.siteId);
  if (pin && JSON.stringify(pin.routing) !== JSON.stringify(routing)) {
    throw new CustomerRoutingError('ROUTING_CHILD_REBIND_FORBIDDEN');
  }
  return withExecutionRouting(routing, routing.siteId, () =>
    withCustomerOperation(pin?.operationId ?? randomUUID(), () =>
      pin?.capability ? withCustomerCapability(pin.capability, operation) : operation()));
}

/** Site-less global compatibility is available only to an authenticated internal service. */
export async function authorizeInferenceRequest(request: Request, requestedSiteId?: unknown) {
  const principal = await resolveToolRequestPrincipal(request);
  if (!principal) throw Object.assign(new Error('Authentication required'), { status: 401 });
  const siteId = requestedSiteId ?? principal.siteId;
  if (siteId === null || siteId === undefined) {
    if (!principal.internal || request.headers.has(HEADER)) throw Object.assign(new Error('Site is required'), { status: 400 });
    return { principal, routing: undefined };
  }
  if (typeof siteId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(siteId)) {
    throw Object.assign(new Error('Invalid site'), { status: 400 });
  }
  if (!await canToolPrincipalAccessSite(principal, siteId)) throw Object.assign(new Error('Site access denied'), { status: 403 });
  return { principal, routing: await resolveHttpExecutionRouting(request, siteId) };
}