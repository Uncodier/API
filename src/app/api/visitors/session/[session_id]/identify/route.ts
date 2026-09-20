import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  VisitorIdentityError,
  identityErrorBody
} from '@/lib/services/visitor-identity/contracts';
import { visitorIdentityService } from '@/lib/services/visitor-identity/orchestration-service';
import { authorizeVisitorSession } from '@/lib/security/authorize-visitor-session';

export const dynamic = 'force-dynamic';

const IdentifySchema = z.object({
  site_id: z.string().uuid(),
  session_id: z.string().uuid(),
  visitor_id: z.string().uuid().optional(),
  lead_id: z.string().uuid().optional(),
  name: z.string().trim().max(250).optional(),
  email: z.string().trim().email().max(320),
  phone: z.string().trim().max(100).optional()
});

function clientIp(request: NextRequest): string | undefined {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || undefined;
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ session_id: string }> }
) {
  try {
    const { session_id: pathSessionId } = await context.params;
    const parsed = IdentifySchema.safeParse(await request.json());
    if (!parsed.success || parsed.data.session_id !== pathSessionId) {
      throw new VisitorIdentityError('invalid_request', 'Identity request is invalid', 400);
    }
    const querySiteId = request.nextUrl.searchParams.get('site_id');
    if (querySiteId && querySiteId !== parsed.data.site_id) {
      throw new VisitorIdentityError('site_mismatch', 'site_id does not match the request URL', 400);
    }
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

    const result = await visitorIdentityService.identify({
      siteId: parsed.data.site_id,
      sessionId: pathSessionId,
      visitorId: parsed.data.visitor_id,
      leadId: parsed.data.lead_id,
      name: parsed.data.name,
      email: parsed.data.email,
      phone: parsed.data.phone,
      requestIp: clientIp(request)
    });
    return NextResponse.json(
      { success: true, data: result },
      {
        status: result.identity_status === 'verification_required'
          ? 202
          : result.identity_status === 'new_lead'
            ? 201
            : 200
      }
    );
  } catch (error) {
    const identityError = error instanceof VisitorIdentityError
      ? error
      : new VisitorIdentityError('internal_error', 'Unable to identify visitor', 500);
    return NextResponse.json(identityErrorBody(identityError), { status: identityError.status });
  }
}
