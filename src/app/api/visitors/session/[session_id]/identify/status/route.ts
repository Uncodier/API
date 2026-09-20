import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  VisitorIdentityError
} from '@/lib/services/visitor-identity/contracts';
import {
  visitorIdentityService
} from '@/lib/services/visitor-identity/orchestration-service';
import {
  assertRouteIdentity,
  visitorIdentityRouteError
} from '@/lib/services/visitor-identity/route-utils';
import { authorizeVisitorSession } from '@/lib/security/authorize-visitor-session';

export const dynamic = 'force-dynamic';

const RestoreIdentitySchema = z.object({
  site_id: z.string().uuid(),
  session_id: z.string().uuid(),
  visitor_id: z.string().uuid().optional(),
  lead_id: z.string().uuid(),
  email: z.string().trim().email().max(320)
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ session_id: string }> }
) {
  try {
    const parsed = RestoreIdentitySchema.safeParse(await request.json());
    if (!parsed.success) {
      throw new VisitorIdentityError(
        'invalid_request',
        'Identity restoration request is invalid',
        400
      );
    }
    const { session_id: pathSessionId } = await context.params;
    assertRouteIdentity(
      pathSessionId,
      parsed.data.session_id,
      parsed.data.site_id,
      request.nextUrl.searchParams.get('site_id')
    );
    if (!await authorizeVisitorSession(request, {
      siteId: parsed.data.site_id,
      sessionId: pathSessionId,
      visitorId: parsed.data.visitor_id,
    })) {
      throw new VisitorIdentityError(
        'forbidden',
        'Visitor session authorization is required',
        403,
      );
    }
    const result = await visitorIdentityService.restore({
      siteId: parsed.data.site_id,
      sessionId: pathSessionId,
      visitorId: parsed.data.visitor_id,
      leadId: parsed.data.lead_id,
      email: parsed.data.email
    });
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return visitorIdentityRouteError(error);
  }
}
