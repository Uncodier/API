import { NextResponse } from 'next/server';
import { hasAuthenticatedPrincipal, isInternalServiceRequest } from '@/lib/security/request-rate-limit';
import { CHANNEL_MESSAGE_UUID, normalizeMessageChannel } from '@/lib/services/workflow-robot/channel-message';

/** Middleware establishes the principal; these routes also enforce service-only scope. */
export function requireChannelMessageService(request: Request): NextResponse | null {
  if (!hasAuthenticatedPrincipal(request) || !isInternalServiceRequest(request)) {
    return NextResponse.json({ success: false, error: 'Service authentication is required' }, { status: 401 });
  }
  return null;
}

export function validChannelMessageIdentity(body: Record<string, unknown>): boolean {
  return typeof body.siteId === 'string' && CHANNEL_MESSAGE_UUID.test(body.siteId)
    && typeof body.messageId === 'string' && body.messageId.trim().length > 0 && body.messageId.length <= 256;
}

export function validChannelMessageId(id: unknown): id is string {
  return typeof id === 'string' && CHANNEL_MESSAGE_UUID.test(id);
}

export function validChannel(value: unknown): value is string {
  return typeof value === 'string' && Boolean(normalizeMessageChannel(value));
}

export async function readChannelMessageBody(request: Request): Promise<Record<string, unknown> | null> {
  // Avoid accepting arbitrarily large bodies before validation.
  const length = Number(request.headers.get('content-length'));
  if (length > 20_000) return null;
  const text = await request.text();
  if (text.length > 20_000) return null;
  try {
    const body = JSON.parse(text);
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch { return null; }
}