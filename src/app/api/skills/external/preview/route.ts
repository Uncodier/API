import { NextRequest, NextResponse } from 'next/server';
import { previewExternalSkill } from '@/lib/services/external-skills-service';
import { externalBodySchema, failure, parseSkillJson, requireSkillSite, skillRouteError } from '../../_shared';

export async function POST(request: NextRequest) {
  try {
    if (!request.headers.get('x-auth-validated') && !request.headers.get('x-api-key-data')) {
      return failure('unauthorized', 401, 'Authentication is required');
    }
    const { site_id, url } = externalBodySchema.parse(await parseSkillJson(request));
    const denied = await requireSkillSite(request, site_id);
    if (denied) return denied;
    return NextResponse.json({ success: true, preview: await previewExternalSkill(url) });
  } catch (error) { return skillRouteError(error); }
}