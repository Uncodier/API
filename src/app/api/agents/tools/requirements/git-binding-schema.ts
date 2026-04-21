/**
 * Zod schema for the `metadata.git` sub-object accepted by requirement
 * create/update routes. Keeps the shape in sync with
 * `requirement-git-binding.ts` without creating a circular import between
 * the pure types file and Zod (runtime validation lives here).
 */

import { z } from 'zod';

export const GitBindingKindSchema = z.enum(['applications', 'automation', 'custom']);

export const GitBindingSchema = z.object({
  kind: GitBindingKindSchema,
  org: z.string().trim().min(1, 'metadata.git.org is required'),
  repo: z.string().trim().min(1, 'metadata.git.repo is required'),
  default_branch: z.string().trim().min(1).default('main'),
  preview: z
    .object({
      provider: z.string().trim().min(1).optional(),
    })
    .partial()
    .optional(),
});

export const PartialGitBindingSchema = GitBindingSchema.partial();

export const RequirementMetadataSchema = z
  .record(z.unknown())
  .and(
    z.object({
      git: GitBindingSchema.optional(),
    }),
  );

export const PartialRequirementMetadataSchema = z
  .record(z.unknown())
  .and(
    z.object({
      git: PartialGitBindingSchema.optional(),
    }),
  );

/**
 * Optional GitHub existence check behind the `REQUIREMENT_GIT_STRICT` flag.
 * Returns `null` on success, or a short error string when the repo is
 * unreachable. Never throws: the gate should be advisory in rollout phase.
 */
export async function verifyGitBindingReachable(binding: {
  org: string;
  repo: string;
}): Promise<string | null> {
  if (process.env.REQUIREMENT_GIT_STRICT !== 'true') return null;
  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = { Accept: 'application/vnd.github.v3+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const url = `https://api.github.com/repos/${encodeURIComponent(binding.org)}/${encodeURIComponent(binding.repo)}`;
    const res = await fetch(url, { headers });
    if (res.status === 200) return null;
    return `GitHub API returned ${res.status} for ${binding.org}/${binding.repo}`;
  } catch (err: any) {
    return `GitHub API check failed for ${binding.org}/${binding.repo}: ${err?.message || err}`;
  }
}
