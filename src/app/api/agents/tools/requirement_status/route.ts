import { NextRequest, NextResponse } from 'next/server';
import {
  createRequirementStatusCore,
  listRequirementStatusCore,
} from '@/lib/tools/requirement-status-core';

// Re-export for backwards compatibility with code that previously imported the
// core helpers through the route file. New callers (workflows, cron helpers,
// assistant protocols) MUST import from `@/lib/tools/requirement-status-core`
// directly — importing anything that lives next to this `route.ts` causes the
// Vercel Workflow bundler to co-bundle `next/server` and crashes with
// `ReferenceError: __dirname is not defined` at workflow init time.
export { createRequirementStatusCore, listRequirementStatusCore };

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await createRequirementStatusCore(body);
    return NextResponse.json(result, { status: 201 });
  } catch (error: any) {
    console.error('Error in requirement_status tool:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Internal server error' },
      { status: error.message?.includes('are required') ? 400 : 500 },
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const requirement_id = url.searchParams.get('requirement_id');
    const instance_id = url.searchParams.get('instance_id');

    if (!requirement_id) {
      return NextResponse.json({ success: false, error: 'requirement_id is required' }, { status: 400 });
    }

    const result = await listRequirementStatusCore({
      requirement_id,
      instance_id: instance_id || undefined,
    });
    return NextResponse.json(result);
  } catch (error: any) {
    console.error('Error getting requirement_status:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Internal server error' },
      { status: 500 },
    );
  }
}
