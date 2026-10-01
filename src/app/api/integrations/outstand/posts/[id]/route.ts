import { handlePostRequest, type PostRouteContext } from '@/lib/integrations/outstand/post-handler';

export const maxDuration = 75;

export async function GET(request: Request, context: PostRouteContext) {
  return handlePostRequest(request, context);
}

export async function DELETE(request: Request, context: PostRouteContext) {
  return handlePostRequest(request, context);
}
