import { NextRequest, NextResponse } from 'next/server';
import { deleteSiteSkill, skillIdSchema, updateSiteSkill } from '@/lib/services/site-skills-catalog';
import { failure, parseSkillJson, requireSkillSiteManager, updateSkillBodySchema, skillRouteError } from '../_shared';

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, context: Context) {
  try {
    if (!request.headers.get('x-auth-validated') && !request.headers.get('x-api-key-data')) {
      return failure('unauthorized', 401, 'Authentication is required');
    }
    const { id } = await context.params;
    skillIdSchema.parse(id);
    const { site_id, ...changes } = updateSkillBodySchema.parse(await parseSkillJson(request));
    const denied = await requireSkillSiteManager(request, site_id);
    if (denied) return denied;
    return NextResponse.json({ success: true, skill: await updateSiteSkill(site_id, id, changes) });
  } catch (error) { return skillRouteError(error); }
}

export async function DELETE(request: NextRequest, context: Context) {
  try {
    const { id } = await context.params;
    skillIdSchema.parse(id);
    const siteId = request.nextUrl.searchParams.get('site_id');
    if (!siteId) return failure('invalid_request', 400, 'site_id is required');
    const denied = await requireSkillSiteManager(request, siteId);
    if (denied) return denied;
    await deleteSiteSkill(siteId, id);
    return NextResponse.json({ success: true });
  } catch (error) { return skillRouteError(error); }
}