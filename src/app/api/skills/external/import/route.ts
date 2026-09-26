import { NextRequest, NextResponse } from 'next/server';
import { importExternalSkill } from '@/lib/services/external-skills-service';
import { importBodySchema, failure, parseSkillJson, requireSkillSiteManager, skillRouteError } from '../../_shared';

export async function POST(request: NextRequest) {
  try {
    if (!request.headers.get('x-auth-validated') && !request.headers.get('x-api-key-data')) {
      return failure('unauthorized', 401, 'Authentication is required');
    }
    const { site_id, url, sha256 } = importBodySchema.parse(await parseSkillJson(request));
    const denied = await requireSkillSiteManager(request, site_id);
    if (denied) return denied;
    const skill = await importExternalSkill(site_id, url, request.headers.get('x-auth-user-id')!, sha256);
    return NextResponse.json({ success: true, skill }, { status: 201 });
  } catch (error) { return skillRouteError(error); }
}