import { NextRequest } from 'next/server';
import { z } from 'zod';
import { VisitorIdentityError } from '@/lib/services/visitor-identity/contracts';
import { visitorIdentityService } from '@/lib/services/visitor-identity/orchestration-service';
import { assertRouteIdentity, visitorIdentityRouteError } from '@/lib/services/visitor-identity/route-utils';

const CancelSchema = z.object({
  site_id: z.string().uuid(),
  session_id: z.string().uuid(),
  challenge_id: z.string().uuid()
});

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ session_id: string }> }
) {
  try {
    const parsed = CancelSchema.safeParse(await request.json());
    if (!parsed.success) {
      throw new VisitorIdentityError('invalid_request', 'Cancel request is invalid', 400);
    }
    const { session_id: pathSessionId } = await context.params;
    assertRouteIdentity(
      pathSessionId,
      parsed.data.session_id,
      parsed.data.site_id,
      request.nextUrl.searchParams.get('site_id')
    );
    await visitorIdentityService.cancel({
      siteId: parsed.data.site_id,
      sessionId: pathSessionId,
      challengeId: parsed.data.challenge_id
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    return visitorIdentityRouteError(error);
  }
}
