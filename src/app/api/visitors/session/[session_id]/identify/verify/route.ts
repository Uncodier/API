import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { VisitorIdentityError } from '@/lib/services/visitor-identity/contracts';
import { visitorIdentityService } from '@/lib/services/visitor-identity/orchestration-service';
import { assertRouteIdentity, visitorIdentityRouteError } from '@/lib/services/visitor-identity/route-utils';

const VerifySchema = z.object({
  site_id: z.string().uuid(),
  session_id: z.string().uuid(),
  challenge_id: z.string().uuid(),
  code: z.string().regex(/^\d{6}$/)
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ session_id: string }> }
) {
  try {
    const parsed = VerifySchema.safeParse(await request.json());
    if (!parsed.success) {
      throw new VisitorIdentityError('invalid_request', 'Verification request is invalid', 400);
    }
    const { session_id: pathSessionId } = await context.params;
    assertRouteIdentity(
      pathSessionId,
      parsed.data.session_id,
      parsed.data.site_id,
      request.nextUrl.searchParams.get('site_id')
    );
    const result = await visitorIdentityService.verify({
      siteId: parsed.data.site_id,
      sessionId: pathSessionId,
      challengeId: parsed.data.challenge_id,
      code: parsed.data.code
    });
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return visitorIdentityRouteError(error);
  }
}
