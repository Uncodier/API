import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { VisitorIdentityError } from '@/lib/services/visitor-identity/contracts';
import { requireIdentitySession } from '@/lib/services/visitor-identity/token-auth';
import { identityRateLimit, identityResponse, readIdentityBody, tokenRouteError } from '@/lib/services/visitor-identity/token-http';
import { assertRouteIdentity } from '@/lib/services/visitor-identity/route-utils';

const AttributesSchema = z.object({
  site_id: z.string().uuid(), session_id: z.string().uuid(),
  visitor_id: z.string().uuid().optional(),
  // Legacy clients may send this field. It never grants or changes identity.
  lead_id: z.string().uuid().optional(),
  name: z.string().trim().max(250).optional(),
  email: z.string().trim().email().max(320).optional(),
  phone: z.string().trim().max(100).optional(),
}).strict();

export async function POST(request: Request, context: { params: Promise<{ session_id: string }> }) {
  try {
    const limited = await identityRateLimit(request, 'attributes');
    if (limited) return limited;
    const body = AttributesSchema.parse(await readIdentityBody(request));
    const { session_id } = await context.params;
    assertRouteIdentity(session_id, body.session_id, body.site_id, new URL(request.url).searchParams.get('site_id'));
    const session = await requireIdentitySession(request, body.site_id, session_id);
    if (body.visitor_id && body.visitor_id !== session.visitorId) {
      throw new VisitorIdentityError('invalid_request', 'Visitor does not match session', 400);
    }
    // Separate untrusted attributes from canonical session/grant/lead columns.
    const { error } = await supabaseAdmin.from('visitor_identity_attributes').upsert({
      session_id, attributes: { name: body.name, email: body.email, phone: body.phone },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'session_id' });
    if (error) throw new VisitorIdentityError('identity_storage_error', 'Unable to save visitor attributes', 503);
    return identityResponse({ identity_status: 'unverified' });
  } catch (error) { return tokenRouteError(error); }
}
