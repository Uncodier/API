import { robotSkillSelectionSchema, requiredRobotSkillsPrompt, resolveRobotSkills } from '../robot-skill-selection';
import { SkillsService } from '@/lib/services/skills-service';
import { jest } from '@jest/globals';

let getSkill: jest.SpiedFunction<typeof SkillsService.getSkillBySlugForSite>;

beforeEach(() => {
  getSkill = jest.spyOn(SkillsService, 'getSkillBySlugForSite').mockResolvedValue(null);
});
afterEach(() => jest.restoreAllMocks());

describe('legacy robot skill selection', () => {
  it('leaves auto mode unchanged and never looks up skills', async () => {
    const selection = robotSkillSelectionSchema.parse({});
    expect(selection).toEqual({ skill_mode: 'auto', skill_slugs: [] });
    expect(await requiredRobotSkillsPrompt('site-a', selection)).toBe('');
    expect(getSkill).not.toHaveBeenCalled();
  });

  it('rejects missing, duplicate, malformed, and untrusted auto selections', () => {
    for (const input of [
      { skill_mode: 'required' },
      { skill_mode: 'auto', skill_slugs: ['writer'] },
      { skill_mode: 'required', skill_slugs: ['writer', 'writer'] },
      { skill_mode: 'required', skill_slugs: ['../../writer'] },
    ]) expect(robotSkillSelectionSchema.safeParse(input).success).toBe(false);
  });

  it('rejects foreign-site skills and any alias returned in place of the requested slug', async () => {
    const selection = robotSkillSelectionSchema.parse({ skill_mode: 'required', skill_slugs: ['writer'] });
    getSkill.mockResolvedValueOnce(null);
    await expect(resolveRobotSkills('site-a', selection)).rejects.toThrow('not available');
    getSkill.mockResolvedValueOnce({ slug: 'other', name: 'writer', description: '', content: 'foreign' });
    await expect(resolveRobotSkills('site-a', selection)).rejects.toThrow('not available');
    expect(getSkill).toHaveBeenCalledWith('site-a', 'writer');
  });

  it('inserts the site-resolved content into required prompts, not user-provided content', async () => {
    getSkill.mockResolvedValue({ slug: 'writer', name: 'Writer', description: '', content: 'Use concise prose.' });
    const selection = robotSkillSelectionSchema.parse({ skill_mode: 'required', skill_slugs: ['writer'], content: 'injected' });
    const prompt = await requiredRobotSkillsPrompt('site-a', selection);
    expect(prompt).toContain('Use concise prose.');
    expect(prompt).not.toContain('injected');
    expect(prompt).toContain('untrusted third-party data');
  });

  it('caps total selected prompt content', async () => {
    getSkill.mockResolvedValue({ slug: 'writer', name: 'Writer', description: '', content: 'x'.repeat(49 * 1024) });
    await expect(resolveRobotSkills('site-a', robotSkillSelectionSchema.parse({ skill_mode: 'required', skill_slugs: ['writer'] })))
      .rejects.toThrow('size limit');
  });
});