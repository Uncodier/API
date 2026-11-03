import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getInstancePlansCore, InstancePlansReadForbiddenError } from './core';
import { resolveToolRequestPrincipal, canToolPrincipalAccessSite } from '@/lib/security/tool-request-principal';

export async function POST(request: NextRequest) {
  try {
    const principal = await resolveToolRequestPrincipal(request);
    if (!principal) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    const body = await request.json();
    const siteId = z.string().uuid().parse(body.site_id);
    if (!await canToolPrincipalAccessSite(principal, siteId)) {
      return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });
    }
    const result = await getInstancePlansCore(body, principal);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof InstancePlansReadForbiddenError) {
      return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });
    }
    console.error('[GetInstancePlan] Error:', error);
    if (error instanceof z.ZodError) {
        return NextResponse.json({ success: false, error: 'Invalid filters', details: error.errors }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Internal Server Error' }, { status: 500 });
  }
}