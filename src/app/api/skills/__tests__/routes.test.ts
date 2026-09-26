import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { NextRequest } from 'next/server';
import { z } from 'zod';

const canAccessSite = jest.fn<(...args: any[]) => Promise<boolean>>();
const isSiteSkillManager = jest.fn<(...args: any[]) => Promise<boolean>>();
const createSiteSkill = jest.fn<(...args: any[]) => Promise<any>>();
const listSiteSkills = jest.fn<(...args: any[]) => Promise<any>>();
const updateSiteSkill = jest.fn<(...args: any[]) => Promise<any>>();
const deleteSiteSkill = jest.fn<(...args: any[]) => Promise<any>>();
const listSkills = jest.fn<(...args: any[]) => any[]>();

jest.unstable_mockModule('@/lib/security/site-access', () => ({ canAccessSite }));
jest.unstable_mockModule('@/lib/services/site-skill-access', () => ({ isSiteSkillManager }));
jest.unstable_mockModule('@/lib/security/request-rate-limit', () => ({
  hasAuthenticatedPrincipal: (request: Request) => request.headers.get('x-auth-validated') === 'true',
}));
jest.unstable_mockModule('@/lib/services/site-skills-catalog', () => ({
  createSiteSkill, listSiteSkills, updateSiteSkill, deleteSiteSkill,
  skillIdSchema: z.string().uuid(),
  skillSiteIdSchema: z.string().uuid(),
  SkillCatalogError: class SkillCatalogError extends Error {},
}));
jest.unstable_mockModule('@/lib/services/skills-service', () => ({ SkillsService: { listSkills } }));

let root: typeof import('../route');
let item: typeof import('../[id]/route');
let system: typeof import('../system/route');
const site = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const content = '---\nname: Example\n---\nBody';
function request(url: string, method = 'GET', body?: unknown, authorized = true): NextRequest {
  return new NextRequest(url, {
    method,
    headers: authorized ? { 'x-auth-validated': 'true', 'x-auth-user-id': id } : {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('site skills API admission', () => {
  beforeAll(async () => {
    root = await import('../route');
    item = await import('../[id]/route');
    system = await import('../system/route');
  });
  beforeEach(() => {
    jest.clearAllMocks();
    canAccessSite.mockResolvedValue(true);
    isSiteSkillManager.mockResolvedValue(true);
    listSiteSkills.mockResolvedValue([]);
    listSkills.mockReturnValue([]);
    createSiteSkill.mockResolvedValue({ id });
    updateSiteSkill.mockResolvedValue({ id });
    deleteSiteSkill.mockResolvedValue(undefined);
  });

  it('blocks unauthenticated GET/POST and cross-site writes before touching storage', async () => {
    expect((await root.GET(request(`https://example.test/api/skills?site_id=${site}`, 'GET', undefined, false))).status).toBe(401);
    expect((await root.POST(request('https://example.test/api/skills', 'POST', { site_id: site, content }, false))).status).toBe(401);
    isSiteSkillManager.mockResolvedValue(false);
    expect((await root.POST(request('https://example.test/api/skills', 'POST', { site_id: site, content }))).status).toBe(403);
    expect(createSiteSkill).not.toHaveBeenCalled();
  });

  it('requires site-scoped ownership for delete and patch', async () => {
    isSiteSkillManager.mockResolvedValue(false);
    expect((await item.DELETE(request(`https://example.test/api/skills/${id}?site_id=${site}`), { params: Promise.resolve({ id }) })).status).toBe(403);
    expect((await item.PATCH(request(`https://example.test/api/skills/${id}`, 'PATCH', { site_id: site, content }), { params: Promise.resolve({ id }) })).status).toBe(403);
    expect(deleteSiteSkill).not.toHaveBeenCalled();
    expect(updateSiteSkill).not.toHaveBeenCalled();
  });

  it('denies writes for active non-manager site members even if reads are allowed', async () => {
    canAccessSite.mockResolvedValue(true);
    isSiteSkillManager.mockResolvedValue(false);
    expect((await root.GET(request(`https://example.test/api/skills?site_id=${site}`))).status).toBe(200);
    expect((await root.POST(request('https://example.test/api/skills', 'POST', { site_id: site, content }))).status).toBe(403);
    expect(createSiteSkill).not.toHaveBeenCalled();
  });

  it('lists builtins as immutable rows and retains disabled site records', async () => {
    listSiteSkills.mockResolvedValue([{ id, slug: 'mine', source: 'custom', enabled: false }]);
    listSkills.mockReturnValue([{ slug: 'mine', content }, { slug: 'base', content }]);
    const response = await root.GET(request(`https://example.test/api/skills?site_id=${site}`));
    const data = await response.json();
    expect(data.skills.map((skill: { slug: string }) => skill.slug)).toEqual(['mine', 'mine', 'base']);
    expect(data.skills[2]).toMatchObject({ id: 'system:base', source: 'system', enabled: true });
  });

  it('lists every bundled skill even when site skill storage is unavailable', async () => {
    listSiteSkills.mockRejectedValue(new Error('site_skills table unavailable'));
    listSkills.mockReturnValue([
      { slug: 'backend', name: 'Backend', description: 'API work', content: '# Backend', types: ['develop'] },
      { slug: 'qa', name: 'QA', description: 'Tests', content: '# QA' },
    ]);
    const response = await system.GET(request(`https://example.test/api/skills/system?site_id=${site}`));
    const result = await response.json();
    expect(result.skills).toHaveLength(2);
    expect(result.skills[0]).toMatchObject({ id: 'system:backend', source: 'system', content: '# Backend' });
    expect(listSiteSkills).not.toHaveBeenCalled();
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect((await system.GET(request(`https://example.test/api/skills/system?site_id=${site}`, 'GET', undefined, false))).status).toBe(401);
  });
});