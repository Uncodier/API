import { runHealthHandlerResponse } from '@/lib/status/health-route-helper';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const live = new URL(request.url).searchParams.get('live') === '1';
  return runHealthHandlerResponse('ai_video', { live });
}
