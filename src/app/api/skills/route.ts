import { NextRequest, NextResponse } from 'next/server';
import { createSiteSkill, listSiteSkills } from '@/lib/services/site-skills-catalog';
import { SkillsService } from '@/lib/services/skills-service';
import { failure, parseSkillJson, requireSkillSite, requireSkillSiteManager, skillBodySchema, skillRouteError } from './_shared';

export async function GET(request: NextRequest) {
  try {
    const siteId = request.nextUrl.searchParams.get('site_id');
    if (!siteId) return failure('invalid_request', 400, 'site_id is required');
    const denied = await requireSkillSite(request, siteId);
    if (denied) return denied;
    const system = SkillsService.listSkills()
      .map(skill => ({ ...skill, id: `system:${skill.slug}`, site_id: null, source: 'system',
        source_url: null, enabled: true, created_at: null, updated_at: null }));
    const custom = await listSiteSkills(siteId);
    return NextResponse.json({ success: true, skills: [...custom, ...system] });
  } catch (error) { return skillRouteError(error); }
}

export async function POST(request: NextRequest) {
  try {
    if (!request.headers.get('x-auth-validated') && !request.headers.get('x-api-key-data')) {
      return failure('unauthorized', 401, 'Authentication is required');
    }
    const { site_id, content } = skillBodySchema.parse(await parseSkillJson(request));
    const denied = await requireSkillSiteManager(request, site_id);
    if (denied) return denied;
    const actorId = request.headers.get('x-auth-user-id') ?? undefined;
    return NextResponse.json({ success: true, skill: await createSiteSkill(site_id, content, { actorId }) }, { status: 201 });
  } catch (error) { return skillRouteError(error); }
}