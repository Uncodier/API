import { NextRequest } from 'next/server';
import { runHealthHandlerResponse } from '@/lib/status/health-route-helper';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ systemKey: string }> },
) {
  const { systemKey } = await context.params;
  const live = request.nextUrl.searchParams.get('live') === '1';
  return runHealthHandlerResponse(systemKey, { live });
}
