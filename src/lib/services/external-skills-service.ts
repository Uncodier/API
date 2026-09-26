import { createHash } from 'node:crypto';
import { createSiteSkill, parseSkillContent, SkillCatalogError, type SiteSkill } from './site-skills-catalog';

export interface ExternalSkillResult {
  name: string;
  description: string;
  url: string;
  repository: string;
  stars?: number;
  forks?: number;
}

export type ExternalSkillPreview = ReturnType<typeof parseSkillContent> & { source_url: string; sha256: string };

/** URLs are parsed rather than proxied: only the fixed GitHub raw-content host is fetched. */
export function normalizeGithubSkillUrl(input: string): string {
  if (typeof input !== 'string' || input.length > 2048) {
    throw new SkillCatalogError('invalid_url', 400, 'Invalid GitHub SKILL.md URL');
  }
  let url: URL;
  try { url = new URL(input); } catch { throw new SkillCatalogError('invalid_url', 400, 'Invalid GitHub SKILL.md URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) {
    throw new SkillCatalogError('invalid_url', 400, 'Only public HTTPS GitHub SKILL.md URLs are supported');
  }
  const host = url.hostname.toLowerCase();
  if (!['github.com', 'raw.githubusercontent.com'].includes(host)) {
    throw new SkillCatalogError('invalid_url', 400, 'Only GitHub SKILL.md URLs are supported');
  }
  const segments = url.pathname.split('/').slice(1);
  if (host === 'github.com') {
    if (segments[2] !== 'blob' || segments.length < 5) {
      throw new SkillCatalogError('invalid_url', 400, 'Expected a GitHub blob SKILL.md URL');
    }
    segments.splice(2, 1);
  }
  if (segments.length < 4 || segments.at(-1)?.toLowerCase() !== 'skill.md' ||
    segments.some(segment => !segment || segment === '.' || segment === '..' || /%|\\|[^a-zA-Z0-9._~-]/.test(segment)) ||
    !/^[a-zA-Z0-9-]+$/.test(segments[0]) || !/^[a-zA-Z0-9_.-]+$/.test(segments[1])) {
    throw new SkillCatalogError('invalid_url', 400, 'Invalid GitHub SKILL.md path');
  }
  return `https://raw.githubusercontent.com/${segments.join('/')}`;
}

async function limitedFetch(url: string, maxBytes: number): Promise<Response> {
  let response: Response;
  const isGithubApi = new URL(url).hostname === 'api.github.com';
  const githubToken = isGithubApi ? process.env.GITHUB_TOKEN?.trim() : undefined;
  try {
    response = await fetch(url, {
      redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(10000),
      headers: {
        Accept: isGithubApi ? 'application/vnd.github+json' : 'text/plain',
        'User-Agent': 'Uncodie-Skills-Catalog',
        ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
      },
    });
  } catch {
    throw new SkillCatalogError('external_unavailable', 502, 'GitHub is temporarily unavailable');
  }
  if (!response.ok || response.status >= 300) {
    await response.body?.cancel();
    if (isGithubApi && (response.status === 429 || (response.status === 403
      && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after'))))) {
      throw new SkillCatalogError('external_rate_limited', 429, 'GitHub search is rate limited. Please retry later.');
    }
    throw new SkillCatalogError(
      'external_unavailable', 502,
      isGithubApi ? 'GitHub search is temporarily unavailable' : 'Unable to fetch public SKILL.md from GitHub',
    );
  }
  const length = Number(response.headers.get('content-length'));
  if (length > maxBytes) {
    await response.body?.cancel();
    throw new SkillCatalogError('invalid_content', 400, 'GitHub response is too large');
  }
  return response;
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new SkillCatalogError('external_unavailable', 502, 'Empty GitHub response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new SkillCatalogError('invalid_content', 400, 'GitHub response is too large');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
}

export async function previewExternalSkill(url: string): Promise<ExternalSkillPreview> {
  const source_url = normalizeGithubSkillUrl(url);
  const response = await limitedFetch(source_url, 131072);
  const content = await readLimited(response, 131072);
  if (/\uFFFD/.test(content)) throw new SkillCatalogError('invalid_content', 400, 'SKILL.md must be valid UTF-8');
  return { ...parseSkillContent(content), source_url, sha256: createHash('sha256').update(content, 'utf8').digest('hex') };
}

export async function importExternalSkill(siteId: string, url: string, actorId: string, expectedSha256: string): Promise<SiteSkill> {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new SkillCatalogError('invalid_preview', 400, 'Preview the skill before importing');
  }
  const skill = await previewExternalSkill(url);
  if (skill.sha256 !== expectedSha256) {
    throw new SkillCatalogError('preview_changed', 409, 'Community skill changed after preview; review it again');
  }
  return createSiteSkill(siteId, skill.content, {
    source: 'github', sourceUrl: skill.source_url, actorId,
  });
}

type GithubSkillTree = { truncated?: boolean; tree?: Array<{ path?: string; type?: string }> };

/** Find public SKILL.md files on the repository's default branch, including nested skill folders. */
async function listRepositorySkillUrls(repo: { full_name: string; default_branch: string }): Promise<string[]> {
  const [owner, name] = repo.full_name.split('/');
  const endpoint = `https://api.github.com/repos/${owner}/${name}/git/trees/${repo.default_branch}?recursive=1`;
  try {
    const response = await limitedFetch(endpoint, 350000);
    const tree = JSON.parse(await readLimited(response, 350000)) as GithubSkillTree;
    if (tree.truncated || !Array.isArray(tree.tree)) return [];
    const paths = tree.tree.filter(entry => entry.type === 'blob' && typeof entry.path === 'string'
      && entry.path.split('/').length <= 6 && entry.path.split('/').pop()?.toLowerCase() === 'skill.md'
      && entry.path.split('/').every(part => /^[a-zA-Z0-9._~-]+$/.test(part) && part !== '.' && part !== '..'));
    return paths.slice(0, 5).map(entry =>
      `https://raw.githubusercontent.com/${repo.full_name}/${repo.default_branch}/${entry.path}`);
  } catch {
    // The tree API can be unavailable or rate-limited; root-only fallback remains supported.
    return [`https://raw.githubusercontent.com/${repo.full_name}/${repo.default_branch}/SKILL.md`];
  }
}

/** Public GitHub discovery: validate each suggested file before exposing it to the user. */
export async function searchExternalSkills(query: string): Promise<ExternalSkillResult[]> {
  const q = query?.trim();
  if (!q || q.length > 100) throw new SkillCatalogError('invalid_query', 400, 'Query must be between 1 and 100 characters');
  const response = await limitedFetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(`${q} agent skills in:name,description,readme`)}&per_page=12`, 250000);
  let repositories: { items?: Array<{
    full_name?: string; default_branch?: string; description?: string | null;
    stargazers_count?: number; forks_count?: number;
  }> };
  try { repositories = JSON.parse(await readLimited(response, 250000)); }
  catch { throw new SkillCatalogError('external_unavailable', 502, 'Invalid GitHub search response'); }
  const items = Array.isArray(repositories.items) ? repositories.items : [];
  const suggestions = await Promise.all(items.slice(0, 8).map(async (repo): Promise<ExternalSkillResult[]> => {
    if (!repo.full_name || !repo.default_branch || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo.full_name)
      || !/^[a-zA-Z0-9._-]+$/.test(repo.default_branch)) return [];
    const urls = await listRepositorySkillUrls({ full_name: repo.full_name, default_branch: repo.default_branch });
    const found = await Promise.all(urls.map(async (url): Promise<ExternalSkillResult | null> => {
      try {
        const preview = await previewExternalSkill(url);
        return {
          name: preview.name, description: preview.description || repo.description || '', url, repository: repo.full_name!,
          ...(typeof repo.stargazers_count === 'number' && Number.isSafeInteger(repo.stargazers_count) && repo.stargazers_count >= 0
            ? { stars: repo.stargazers_count } : {}),
          ...(typeof repo.forks_count === 'number' && Number.isSafeInteger(repo.forks_count) && repo.forks_count >= 0
            ? { forks: repo.forks_count } : {}),
        };
      } catch { return null; }
    }));
    return found.filter((result): result is ExternalSkillResult => result !== null);
  }));
  return suggestions.flat().slice(0, 20);
}