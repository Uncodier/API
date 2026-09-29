import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { VisitorIdentityError } from '@/lib/services/visitor-identity/contracts';
import { requireIdentitySession } from '@/lib/services/visitor-identity/token-auth';
import { identityRateLimit, identityResponse, readIdentityBody, tokenRouteError } from '@/lib/services/visitor-identity/token-http';
import { identifySchema } from './types';

// Legacy plain identify remains attributes-only. Neither API keys nor browser
// lead hints authorize lead mutation, visitor merging, or conversation history.
export async function POST(request: NextRequest) {
  try {
    const limited = await identityRateLimit(request, 'legacy-attributes');
    if (limited) return limited;
    const body = identifySchema.parse(await readIdentityBody(request));
    const session = await requireIdentitySession(request, body.site_id, body.session_id);
    if (body.id !== session.visitorId) {
      throw new VisitorIdentityError('invalid_request', 'Visitor does not match session', 400);
    }
    const { error } = await supabaseAdmin.from('visitor_identity_attributes').upsert({
      session_id: session.sessionId,
      attributes: body.traits || {},
      updated_at: new Date().toISOString(),
    }, { onConflict: 'session_id' });
    if (error) throw new VisitorIdentityError('identity_storage_error', 'Unable to save visitor attributes', 503);
    return identityResponse({ identity_status: 'unverified' });
  } catch (error) { return tokenRouteError(error); }
}
