import { jest } from '@jest/globals';
import { externalSkillLookupTool } from '../external-skill-lookup-tool';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: {} }));

const url = 'https://github.com/team/agent-skills/blob/main/sample/SKILL.md';
type SkillService = NonNullable<Parameters<typeof externalSkillLookupTool>[3]>;

describe('external_skill_lookup import boundary', () => {
  const searchExternalSkills = jest.fn<SkillService['searchExternalSkills']>(async () => []);
  const previewExternalSkill = jest.fn<SkillService['previewExternalSkill']>(async () => ({ slug: 'sample', name: 'Sample', content: 'instructions', description: '', types: [], source_url: url, sha256 }));
  const importExternalSkill = jest.fn<SkillService['importExternalSkill']>(async (siteId) => ({
    id: 'skill-1', site_id: siteId, slug: 'sample', name: 'Sample', description: '',
    content: 'instructions', types: [], source: 'github', source_url: url, enabled: true,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  }));
  const isSiteSkillManager = jest.fn(async (_siteId: string, _userId: string) => true);
  const service = { searchExternalSkills, previewExternalSkill, importExternalSkill, isSiteSkillManager };
  const sha256 = 'a'.repeat(64);

  beforeEach(() => jest.clearAllMocks());

  it('lets the assistant discover and preview without saving', async () => {
    const tool = externalSkillLookupTool('site-a', 'user-a', undefined, service);
    await expect(tool.execute({ action: 'search', query: 'agent testing' })).resolves.toMatchObject({ ok: true });
    await expect(tool.execute({ action: 'preview', url })).resolves.toMatchObject({ ok: true });
    expect(importExternalSkill).not.toHaveBeenCalled();
  });

  it('rejects agent-generated confirmation if user did not approve the exact URL', async () => {
    const tool = externalSkillLookupTool('site-a', 'user-a', undefined, service);
    await expect(tool.execute({ action: 'import', url, confirm_import: true, sha256 })).resolves.toMatchObject({ ok: false });
    expect(importExternalSkill).not.toHaveBeenCalled();
  });

  it('does not treat LLM-controlled confirmation or previously approved URLs as authorization', async () => {
    const tool = externalSkillLookupTool('site-a', 'user-a', { url, sha256, userId: 'user-a' }, service);
    await expect(tool.execute({ action: 'import', url, confirm_import: true, sha256: 'b'.repeat(64) })).resolves.toMatchObject({ ok: false });
    expect(importExternalSkill).not.toHaveBeenCalled();
  });

  it('requires manager role and a matching user-authorized review digest', async () => {
    const tool = externalSkillLookupTool('site-a', 'user-a', { url: 'https://raw.githubusercontent.com/team/agent-skills/main/sample/SKILL.md', sha256, userId: 'user-a' }, service);
    isSiteSkillManager.mockResolvedValueOnce(false);
    await expect(tool.execute({ action: 'import', url, confirm_import: true, sha256 })).resolves.toMatchObject({ ok: false });
    expect(importExternalSkill).not.toHaveBeenCalled();
    await expect(tool.execute({ action: 'import', url, confirm_import: true, sha256 })).resolves.toMatchObject({ ok: true });
    expect(importExternalSkill).toHaveBeenCalledWith('site-a', 'https://raw.githubusercontent.com/team/agent-skills/main/sample/SKILL.md', 'user-a', sha256);
  });
});