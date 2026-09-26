import { NextRequest, NextResponse } from 'next/server';
import { SkillsService } from '@/lib/services/skills-service';
import { failure, requireSkillSite, skillRouteError } from '../_shared';

/** Bundled SKILL.md catalog does not depend on the site_skills table. */
export async function GET(request: NextRequest) {
  try {
    const siteId = request.nextUrl.searchParams.get('site_id');
    if (!siteId) return failure('invalid_request', 400, 'site_id is required');
    const denied = await requireSkillSite(request, siteId);
    if (denied) return denied;

    const skills = [...SkillsService.listSkills()].sort((a, b) => a.slug.localeCompare(b.slug)).map(skill => ({
      id: `system:${skill.slug}`,
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
      content: skill.content,
      types: skill.types ?? [],
      source: 'system' as const,
      enabled: true,
    }));
    return NextResponse.json({ success: true, skills }, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) { return skillRouteError(error); }
}