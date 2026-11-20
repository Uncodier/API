import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { CanonicalVisitorIdentity } from '@/lib/services/visitor-identity/VisitorSessionAuthorizationService';
import { verifiedVisitorSessionClaims, visitorSessionTokenFromRequest } from '@/lib/security/visitor-session-token';

const fields = z.object({ siteId: z.string().uuid(), sessionId: z.string().uuid(), visitorId: z.string().uuid(),
  leadId: z.string().uuid().nullable(), conversationId: z.string().uuid(), turn: z.string().regex(/^[a-f0-9]{64}$/),
  digest: z.string().regex(/^[a-f0-9]{64}$/), expires: z.number().int() }).strict();
const key = () => (process.env.VISITOR_SESSION_TOKEN_SECRET || process.env.ENCRYPTION_KEY)?.trim();
const mac = (payload: string, secret: string) => createHmac('sha256', secret).update('connector-visitor-turn-v1:').update(payload).digest();
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

// A browser session bearer must never be put into Temporal history. Mint a short-lived,
// single-turn assertion instead, only for a signed, already ownership-checked conversation.
export async function issueVisitorTurn(request: Request, visitor: CanonicalVisitorIdentity,
  conversationId: unknown, turn: unknown, message: string): Promise<string | undefined> {
  try {
    const secret = key();
    if (!secret || !conversationId) return;
    const claims = await verifiedVisitorSessionClaims(visitorSessionTokenFromRequest(request), visitor);
    if (!claims) return;
    const fieldsValue = fields.parse({ ...visitor, conversationId, turn, digest: digest(message),
      expires: Math.min(claims.expiresAt, Date.now() + 5 * 60_000) });
    const payload = Buffer.from(JSON.stringify(fieldsValue)).toString('base64url');
    return `${payload}.${mac(payload, secret).toString('base64url')}`;
  } catch { return; }
}

export function verifyVisitorTurn(ticket: unknown, message: string, originMessageId: unknown) {
  try {
    const secret = key();
    if (!secret || typeof ticket !== 'string' || ticket.length > 2048) return;
    const [payload, signature, extra] = ticket.split('.');
    if (extra !== undefined || !payload || !signature || !timingSafeEqual(mac(payload, secret), Buffer.from(signature, 'base64url'))) return;
    const data = fields.parse(JSON.parse(Buffer.from(payload, 'base64url').toString()));
    if (data.turn === originMessageId && data.expires > Date.now() && data.digest === digest(message)) return data;
  } catch { /* Absent/invalid assertions do not grant a channel capability. */ }
}
