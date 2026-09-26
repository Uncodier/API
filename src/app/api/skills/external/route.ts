import { NextRequest, NextResponse } from 'next/server';
import { searchExternalSkills } from '@/lib/services/external-skills-service';
import { failure, requireSkillSite, skillRouteError } from '../_shared';

export async function GET(request: NextRequest) {
  try {
    const siteId = request.nextUrl.searchParams.get('site_id');
    if (!siteId) return failure('invalid_request', 400, 'site_id is required');
    const denied = await requireSkillSite(request, siteId);
    if (denied) return denied;
    const results = await searchExternalSkills(request.nextUrl.searchParams.get('query') || '');
    return NextResponse.json({ success: true, results });
  } catch (error) { return skillRouteError(error); }
}