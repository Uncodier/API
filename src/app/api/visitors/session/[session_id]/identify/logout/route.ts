import { NextRequest } from 'next/server';
import { z } from 'zod';
import { VisitorIdentityError } from '@/lib/services/visitor-identity/contracts';
import { visitorIdentityService } from '@/lib/services/visitor-identity/orchestration-service';
import { assertRouteIdentity, visitorIdentityRouteError } from '@/lib/services/visitor-identity/route-utils';

const LogoutSchema = z.object({
  site_id: z.string().uuid(),
  session_id: z.string().uuid()
});

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ session_id: string }> }
) {
  try {
    const parsed = LogoutSchema.safeParse(await request.json());
    if (!parsed.success) {
      throw new VisitorIdentityError('invalid_request', 'Logout request is invalid', 400);
    }
    const { session_id: pathSessionId } = await context.params;
    assertRouteIdentity(
      pathSessionId,
      parsed.data.session_id,
      parsed.data.site_id,
      request.nextUrl.searchParams.get('site_id')
    );
    await visitorIdentityService.revoke({
      siteId: parsed.data.site_id,
      sessionId: pathSessionId
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    return visitorIdentityRouteError(error);
  }
}
