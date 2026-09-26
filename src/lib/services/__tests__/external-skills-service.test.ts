import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { importExternalSkill, normalizeGithubSkillUrl, previewExternalSkill, searchExternalSkills } from '../external-skills-service';

const github = 'https://github.com/some-owner/some-repo/blob/main/.agents/my-skill/SKILL.md';
const raw = 'https://raw.githubusercontent.com/some-owner/some-repo/main/.agents/my-skill/SKILL.md';

describe('public GitHub skills discovery', () => {
  beforeEach(() => { jest.restoreAllMocks(); });

  it('converts GitHub URLs to a fixed safe raw host', () => {
    expect(normalizeGithubSkillUrl(github)).toBe(raw);
    expect(normalizeGithubSkillUrl(raw)).toBe(raw);
    for (const input of [
      'http://github.com/a/b/blob/main/SKILL.md',
      'https://github.com.evil.example/a/b/blob/main/SKILL.md',
      'https://github.com/a/b/blob/main/%2e%2e/SKILL.md',
      'https://github.com/a/b/blob/main/SKILL.md?token=secret',
      'https://raw.githubusercontent.com@169.254.169.254/a/b/main/SKILL.md',
      'https://github.com/a/b/blob/main/OTHER.md',
    ]) expect(() => normalizeGithubSkillUrl(input)).toThrow();
  });

  it('refuses redirects without following them', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ status: 302, ok: false, body: { cancel: jest.fn() } } as unknown as Response);
    await expect(previewExternalSkill(raw)).rejects.toMatchObject({ status: 502 });
    expect(fetchMock).toHaveBeenCalledWith(raw, expect.objectContaining({ redirect: 'manual', cache: 'no-store' }));
  });

  it('rejects streaming bodies beyond the limit even when length is hidden', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('x'.repeat(131073), { status: 200 }));
    await expect(previewExternalSkill(raw)).rejects.toMatchObject({ status: 400 });
  });

  it('only returns verified public root SKILL.md results', async () => {
    const skill = '---\nname: Remote Skill\ndescription: Hello\n---\n# Instructions';
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (url) =>
      new Response(String(url).includes('/search/repositories')
        ? JSON.stringify({ items: [{
          full_name: 'owner/repo', default_branch: 'main', description: 'Repo',
          stargazers_count: 1234, forks_count: 42,
        }] })
        : String(url).includes('/git/trees/')
          ? JSON.stringify({ tree: [{ path: 'SKILL.md', type: 'blob' }] })
          : skill, { status: 200 }));
    await expect(searchExternalSkills('something')).resolves.toEqual([{
      name: 'Remote Skill', description: 'Hello', repository: 'owner/repo', stars: 1234, forks: 42,
      url: 'https://raw.githubusercontent.com/owner/repo/main/SKILL.md',
    }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [url, options] of fetchMock.mock.calls) {
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers.Accept).toBe(String(url).startsWith('https://api.github.com/')
        ? 'application/vnd.github+json' : 'text/plain');
    }
  });

  it('reports GitHub search rate limiting instead of a misleading SKILL.md fetch error', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('rate limit', {
      status: 403, headers: { 'x-ratelimit-remaining': '0' },
    }));
    await expect(searchExternalSkills('email')).rejects.toMatchObject({
      code: 'external_rate_limited', status: 429,
      message: 'GitHub search is rate limited. Please retry later.',
    });
  });

  it('reports other GitHub API failures without claiming the SKILL.md download failed', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('unsupported Accept', { status: 415 }));
    await expect(searchExternalSkills('email')).rejects.toMatchObject({
      code: 'external_unavailable', status: 502,
      message: 'GitHub search is temporarily unavailable',
    });
  });

  it('discovers skills in nested community folders', async () => {
    const skill = '---\nname: Remote Skill\ndescription: Hello\n---\n# Instructions';
    jest.spyOn(global, 'fetch').mockImplementation(async (url) =>
      new Response(String(url).includes('/search/repositories')
        ? JSON.stringify({ items: [{ full_name: 'owner/repo', default_branch: 'main' }] })
        : String(url).includes('/git/trees/')
          ? JSON.stringify({ tree: [{ path: 'skills/nested/SKILL.md', type: 'blob' }] })
          : skill, { status: 200 }));
    await expect(searchExternalSkills('nested')).resolves.toEqual([expect.objectContaining({
      url: 'https://raw.githubusercontent.com/owner/repo/main/skills/nested/SKILL.md',
    })]);
  });

  it('omits missing or invalid popularity metrics rather than presenting them as zero', async () => {
    const skill = '---\nname: Remote Skill\n---\n# Instructions';
    jest.spyOn(global, 'fetch').mockImplementation(async (url) =>
      new Response(String(url).includes('/search/repositories')
        ? JSON.stringify({ items: [
          { full_name: 'owner/unknown', default_branch: 'main', stargazers_count: -1, forks_count: 1.5 },
          { full_name: 'owner/known', default_branch: 'main', stargazers_count: 0 },
        ] })
        : String(url).includes('/git/trees/')
          ? JSON.stringify({ tree: [{ path: 'SKILL.md', type: 'blob' }] })
          : skill, { status: 200 }));
    const results = await searchExternalSkills('skill');
    expect(results).toEqual([
      expect.objectContaining({ repository: 'owner/unknown' }),
      expect.objectContaining({ repository: 'owner/known', stars: 0 }),
    ]);
    expect(results[0]).not.toHaveProperty('stars');
    expect(results[0]).not.toHaveProperty('forks');
    expect(results[1]).not.toHaveProperty('forks');
  });

  it('includes zero metrics without inventing missing or invalid popularity counts', async () => {
    const skill = '---\nname: Remote Skill\n---\n# Instructions';
    jest.spyOn(global, 'fetch').mockImplementation(async (url) =>
      new Response(String(url).includes('/search/repositories')
        ? JSON.stringify({ items: [
          { full_name: 'owner/zero', default_branch: 'main', stargazers_count: 0, forks_count: 0 },
          { full_name: 'owner/unknown', default_branch: 'main', stargazers_count: -1, forks_count: 'many' },
        ] })
        : String(url).includes('/git/trees/')
          ? JSON.stringify({ tree: [{ path: 'SKILL.md', type: 'blob' }] })
          : skill, { status: 200 }));
    await expect(searchExternalSkills('skill')).resolves.toEqual([
      expect.objectContaining({ repository: 'owner/zero', stars: 0, forks: 0 }),
      { name: 'Remote Skill', description: '', repository: 'owner/unknown',
        url: 'https://raw.githubusercontent.com/owner/unknown/main/SKILL.md' },
    ]);
  });

  it('refuses imports if the file changed after preview without persisting anything', async () => {
    const oldContent = '---\nname: Remote Skill\n---\nOld content';
    const newContent = '---\nname: Remote Skill\n---\nNew content';
    jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(oldContent))
      .mockResolvedValueOnce(new Response(newContent));
    const snapshot = await previewExternalSkill(raw);
    await expect(importExternalSkill('11111111-1111-4111-8111-111111111111', raw,
      '22222222-2222-4222-8222-222222222222', snapshot.sha256)).rejects.toMatchObject({ status: 409 });
  });
});