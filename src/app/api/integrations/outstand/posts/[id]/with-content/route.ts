import { handlePostRequest, type PostRouteContext } from '@/lib/integrations/outstand/post-handler';

export const maxDuration = 75;

/** A distinct path fails without mutation when the orchestrator is not deployed yet. */
export async function DELETE(request: Request, context: PostRouteContext) {
  return handlePostRequest(request, context, true);
}