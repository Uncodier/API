import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const dbFrom = jest.fn();
jest.unstable_mockModule('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: dbFrom } }));
jest.unstable_mockModule('../skills-service', () => ({ SkillsService: { listSkills: () => [{ slug: 'system-name' }] } }));
let catalog: typeof import('../site-skills-catalog');
beforeAll(async () => { catalog = await import('../site-skills-catalog'); });

const siteId = '11111111-1111-4111-8111-111111111111';
const otherSite = '22222222-2222-4222-8222-222222222222';
const id = '33333333-3333-4333-8333-333333333333';
const content = "---\nname: Test Skill\ndescription: A test\ntypes: ['task', 'research']\n---\n\n# Body";

describe('site skills catalog', () => {
  beforeEach(() => { dbFrom.mockReset(); });

  it('derives a safe slug and stores original content without changing the body', () => {
    expect(catalog.parseSkillContent(content)).toEqual({ slug: 'test-skill', name: 'Test Skill', description: 'A test', types: ['task', 'research'], content });
  });

  it('accepts an indented literal description with additional scalar metadata and preserves the original file', () => {
    const markdown = [
      '---',
      'name: claude-api',
      'description: |-',
      '  Reference for the Claude API — models, streaming, and tool use.',
      '  TRIGGER — read before modifying an integration: even for one-line changes.',
      '  SKIP when another provider is named.',
      'license: Complete terms in LICENSE.txt',
      '---',
      '',
      '# Building LLM-powered applications',
    ].join('\n');
    expect(catalog.parseSkillContent(markdown)).toEqual({
      slug: 'claude-api', name: 'claude-api',
      description: 'Reference for the Claude API — models, streaming, and tool use.\n'
        + 'TRIGGER — read before modifying an integration: even for one-line changes.\n'
        + 'SKIP when another provider is named.',
      types: [], content: markdown,
    });
  });

  it('accepts a CRLF literal description and honors YAML chomping indicators', () => {
    for (const [indicator, expected] of [
      ['|-', 'First\nSecond'],
      ['|', 'First\nSecond\n'],
      ['|+', 'First\nSecond\n\n'],
    ]) {
      const markdown = `---\r\nname: Test\r\ndescription: ${indicator}\r\n    First\r\n    Second\r\n    \r\nlicense: MIT\r\n---\r\nBody`;
      expect(catalog.parseSkillContent(markdown).description).toBe(expected);
    }
  });

  it('rejects malformed, nested, duplicate or oversized literal metadata', () => {
    for (const frontmatter of [
      'name: Test\ndescription: |-\n  Valid\n  unsafe: nested field\n  More\ntypes: []\n  - research',
      'name: Test\ndescription: |-\nNot indented',
      'name: Test\ndescription: |-\n  First\ndescription: again',
      `name: Test\ndescription: |-\n  ${'x'.repeat(2001)}`,
      'name: Test\ndescription: |-\n  Contains\ta tab',
      'name: Test\ntypes: |-\n  research',
    ]) {
      expect(() => catalog.parseSkillContent(`---\n${frontmatter}\n---\n# Body`)).toThrow();
    }
  });

  it('rejects invalid or oversized frontmatter without a database call', async () => {
    for (const bad of ['# no frontmatter', '---\nname: 💥\n---\n', '---\nname: A\nname: B\n---\n', `${content}${'x'.repeat(131072)}`]) {
      expect(() => catalog.parseSkillContent(bad)).toThrow();
    }
    await expect(catalog.createSiteSkill('invalid', content)).rejects.toThrow();
    expect(dbFrom).not.toHaveBeenCalled();
  });

  it('inserts only the selected site and rejects duplicate slugs', async () => {
    const single = jest.fn<() => Promise<any>>().mockResolvedValue({ data: null, error: { code: '23505' } });
    const select = jest.fn(() => ({ single }));
    const insert = jest.fn(() => ({ select }));
    dbFrom.mockReturnValue({ insert });
    await expect(catalog.createSiteSkill(siteId, content)).rejects.toMatchObject({ status: 409 });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ site_id: siteId, content, slug: 'test-skill' }));
  });

  it('does not allow uploaded skills to impersonate bundled system skills', async () => {
    await expect(catalog.createSiteSkill(siteId, '---\nname: System Name\n---\nBody')).rejects.toMatchObject({ status: 409 });
    expect(dbFrom).not.toHaveBeenCalled();
  });

  it('site-scopes both update and delete before reading a row', async () => {
    const maybeSingle = jest.fn<() => Promise<any>>().mockResolvedValue({ data: null, error: null });
    const select = jest.fn(() => ({ maybeSingle }));
    const eqId = jest.fn(() => ({ select }));
    const eqSite = jest.fn(() => ({ eq: eqId }));
    const update = jest.fn(() => ({ eq: eqSite }));
    const remove = jest.fn(() => ({ eq: eqSite }));
    dbFrom.mockReturnValue({ update, delete: remove });
    await expect(catalog.updateSiteSkill(otherSite, id, { content })).rejects.toMatchObject({ status: 404 });
    await expect(catalog.deleteSiteSkill(otherSite, id)).rejects.toMatchObject({ status: 404 });
    expect(eqSite).toHaveBeenNthCalledWith(1, 'site_id', otherSite);
    expect(eqSite).toHaveBeenNthCalledWith(2, 'site_id', otherSite);
    expect(eqId).toHaveBeenCalledWith('id', id);
  });
});