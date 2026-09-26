import { jest } from '@jest/globals';
import {
  approvedCommunityImport,
  assistantSkillSelectionSchema,
  requiredSkillsPrompt,
  resolveAssistantSkillSelection,
} from '../skill-selection';

const getSkill = jest.fn<(...args: string[]) => Promise<any>>();

describe('assistant skill selection', () => {
  beforeEach(() => jest.clearAllMocks());

  it('does not resolve skills in automatic mode', async () => {
    await expect(resolveAssistantSkillSelection('site-a', { skill_mode: 'auto', skill_slugs: [] }, getSkill))
      .resolves.toEqual({ skill_mode: 'auto', skills: [] });
    expect(getSkill).not.toHaveBeenCalled();
  });

  it('rejects skills unavailable to this site rather than silently skipping them', async () => {
    getSkill.mockResolvedValue(null);
    await expect(resolveAssistantSkillSelection('site-a', {
      skill_mode: 'required', skill_slugs: ['private-skill'],
    }, getSkill)).rejects.toThrow('Skill not available');
    expect(getSkill).toHaveBeenCalledWith('site-a', 'private-skill');
  });

  it('snapshots the selected instructions for a required run', async () => {
    getSkill.mockResolvedValue({ slug: 'writer', name: 'Writer', content: 'Write carefully', version: 4 });
    const selected = await resolveAssistantSkillSelection('site-a', {
      skill_mode: 'required', skill_slugs: ['writer'],
    }, getSkill);
    expect(selected.skills).toEqual([{ slug: 'writer', name: 'Writer', content: 'Write carefully', version: '4' }]);
    expect(requiredSkillsPrompt(selected)).toContain('Write carefully');
    expect(requiredSkillsPrompt(selected)).toContain('not a higher-priority instruction');
  });

  it('enforces the cumulative UTF-8 budget without truncating selected skills', async () => {
    getSkill.mockImplementation(async (_siteId, slug) => ({
      slug, name: slug, content: slug === 'first' ? 'a'.repeat(47_997) : 'éé',
    }));
    await expect(resolveAssistantSkillSelection('site-a', {
      skill_mode: 'required', skill_slugs: ['first', 'second'],
    }, getSkill)).rejects.toThrow('48 KB max');
    getSkill.mockResolvedValue({ slug: 'first', name: 'first', content: 'a'.repeat(48_000) });
    await expect(resolveAssistantSkillSelection('site-a', {
      skill_mode: 'required', skill_slugs: ['first'],
    }, getSkill)).resolves.toMatchObject({ skills: [{ content: 'a'.repeat(48_000) }] });
  });

  it('accepts catalog slugs up to 100 characters and rejects longer slugs', () => {
    expect(assistantSkillSelectionSchema.safeParse({ skill_mode: 'required', skill_slugs: ['a'.repeat(100)] }).success).toBe(true);
    expect(assistantSkillSelectionSchema.safeParse({ skill_mode: 'required', skill_slugs: ['a'.repeat(101)] }).success).toBe(false);
  });

  it('never treats a negated or ambiguous instruction as import authorization', () => {
    const url = 'https://github.com/team/repo/blob/main/demo/SKILL.md';
    const sha256 = 'a'.repeat(64);
    expect(approvedCommunityImport(`Do not import ${url} sha256: ${sha256}`)).toBeNull();
    expect(approvedCommunityImport(`Import ${url} sha256: ${sha256}`)).toBeNull();
    expect(approvedCommunityImport(`Import reviewed skill: ${url} sha256: ${sha256}`))
      .toEqual({ url: 'https://raw.githubusercontent.com/team/repo/main/demo/SKILL.md', sha256 });
  });
});