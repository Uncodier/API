/**
 * Git binding resolution for requirements.
 *
 * A requirement's target repository is stored under `requirements.metadata.git`
 * as the source of truth for the CRUD/sync layer. When metadata is missing
 * (legacy rows, new inserts without explicit binding), we fall back to env
 * vars scoped by `instance_type` to keep back-compat.
 *
 * Shape:
 *   {
 *     kind: 'applications' | 'automation' | 'custom',
 *     org: string,
 *     repo: string,
 *     default_branch: string,
 *     preview?: { provider?: string }
 *   }
 */

import { supabaseAdmin } from '@/lib/database/supabase-server';

export type GitBindingKind = 'applications' | 'automation' | 'custom';

export interface GitBindingPreview {
  provider?: string;
}

export interface GitBinding {
  kind: GitBindingKind;
  org: string;
  repo: string;
  default_branch: string;
  preview?: GitBindingPreview;
}

export const DEFAULT_GIT_ORG_FALLBACK = 'makinary';
export const DEFAULT_APPLICATIONS_REPO_FALLBACK = 'apps';
export const DEFAULT_AUTOMATIONS_REPO_FALLBACK = 'automations';
export const DEFAULT_BRANCH_FALLBACK = 'main';

const VALID_KINDS: readonly GitBindingKind[] = ['applications', 'automation', 'custom'];

/**
 * True when input matches the shape of a persisted git binding. Allows absent
 * `preview` field.
 */
export function isGitBinding(value: unknown): value is GitBinding {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.kind !== 'string' || !VALID_KINDS.includes(v.kind as GitBindingKind)) return false;
  if (typeof v.org !== 'string' || v.org.trim() === '') return false;
  if (typeof v.repo !== 'string' || v.repo.trim() === '') return false;
  if (typeof v.default_branch !== 'string' || v.default_branch.trim() === '') return false;
  if (v.preview !== undefined) {
    if (!v.preview || typeof v.preview !== 'object') return false;
  }
  return true;
}

/**
 * Normalizes raw input (from API, env, etc.) into a GitBinding. Returns null
 * when input is too ambiguous to become a full binding.
 */
export function normalizeGitBindingInput(
  input: Partial<GitBinding> | null | undefined,
  fallback: Partial<GitBinding> = {},
): GitBinding | null {
  if (!input && !fallback) return null;

  const kindRaw = (input?.kind ?? fallback.kind ?? '').toString().trim().toLowerCase();
  const kind = (VALID_KINDS.includes(kindRaw as GitBindingKind)
    ? (kindRaw as GitBindingKind)
    : null);
  if (!kind) return null;

  const org = (input?.org ?? fallback.org ?? '').toString().trim();
  const repo = (input?.repo ?? fallback.repo ?? '').toString().trim();
  const defaultBranch = (input?.default_branch ?? fallback.default_branch ?? DEFAULT_BRANCH_FALLBACK)
    .toString()
    .trim();

  if (!org || !repo || !defaultBranch) return null;

  const preview = input?.preview ?? fallback.preview;
  const binding: GitBinding = { kind, org, repo, default_branch: defaultBranch };
  if (preview && typeof preview === 'object') {
    binding.preview = { ...preview };
  }
  return binding;
}

/**
 * Extracts a git binding from a requirement's metadata column. Accepts either
 * a plain object (Supabase already parses jsonb), or null.
 */
export function parseGitBindingFromMetadata(metadata: unknown): GitBinding | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const git = (metadata as Record<string, unknown>).git;
  if (!git || typeof git !== 'object') return null;
  return isGitBinding(git) ? (git as GitBinding) : normalizeGitBindingInput(git as Partial<GitBinding>);
}

/**
 * Resolves the default git binding from env + instance type. Used when the
 * requirement has no `metadata.git` yet (pre-migration rows or callers that
 * didn't set it).
 */
export function resolveDefaultGitBinding(instanceType?: string | null): GitBinding {
  const isAutomation = String(instanceType || '').trim().toLowerCase() === 'automation';
  const kind: GitBindingKind = isAutomation ? 'automation' : 'applications';
  const org = process.env.GIT_ORG || DEFAULT_GIT_ORG_FALLBACK;
  const repo = isAutomation
    ? (process.env.GIT_AUTOMATIONS_REPO || DEFAULT_AUTOMATIONS_REPO_FALLBACK)
    : (process.env.GIT_APPLICATIONS_REPO || DEFAULT_APPLICATIONS_REPO_FALLBACK);
  const defaultBranch = process.env.GIT_DEFAULT_BRANCH || DEFAULT_BRANCH_FALLBACK;
  return {
    kind,
    org,
    repo,
    default_branch: defaultBranch,
    preview: { provider: 'vercel' },
  };
}

/**
 * Merges an incoming partial git binding onto an existing one. Fields present
 * in `incoming` override the existing binding; `preview` is merged shallowly.
 */
export function mergeGitBinding(
  existing: GitBinding | null | undefined,
  incoming: Partial<GitBinding> | null | undefined,
): GitBinding | null {
  if (!existing && !incoming) return null;
  if (!existing) return normalizeGitBindingInput(incoming ?? {});
  if (!incoming) return existing;

  const merged: GitBinding = {
    kind: (incoming.kind && VALID_KINDS.includes(incoming.kind)
      ? incoming.kind
      : existing.kind),
    org: incoming.org?.toString().trim() || existing.org,
    repo: incoming.repo?.toString().trim() || existing.repo,
    default_branch: incoming.default_branch?.toString().trim() || existing.default_branch,
  };
  if (existing.preview || incoming.preview) {
    merged.preview = { ...(existing.preview ?? {}), ...(incoming.preview ?? {}) };
  }
  return merged;
}

/**
 * Maps a git binding kind into the `instanceType` string used by the sandbox
 * pipeline (sandboxes accept `applications` or `automation` today).
 */
export function instanceTypeFromGitKind(kind: GitBindingKind | undefined | null): 'applications' | 'automation' {
  return kind === 'automation' ? 'automation' : 'applications';
}

/**
 * Produces a full-origin HTTPS GitHub URL for the binding.
 */
export function gitBindingRepoUrl(binding: GitBinding): string {
  return `https://github.com/${binding.org}/${binding.repo}`;
}

/**
 * Produces the tree-URL format stored in requirement_status.repo_url.
 */
export function gitBindingBranchTreeUrl(binding: GitBinding, branch: string): string {
  return `${gitBindingRepoUrl(binding)}/tree/${encodeURIComponent(branch)}`;
}

/**
 * Reads the git binding from the requirement row. Falls back to the default
 * resolution when metadata.git is absent / malformed.
 */
export async function getRequirementGitBinding(
  requirementId: string,
  fallbackInstanceType?: string | null,
): Promise<GitBinding> {
  if (!requirementId) return resolveDefaultGitBinding(fallbackInstanceType);
  const { data } = await supabaseAdmin
    .from('requirements')
    .select('metadata')
    .eq('id', requirementId)
    .maybeSingle();
  const persisted = parseGitBindingFromMetadata(data?.metadata);
  if (persisted) return persisted;
  return resolveDefaultGitBinding(fallbackInstanceType);
}
