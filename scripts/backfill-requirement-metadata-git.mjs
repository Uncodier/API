#!/usr/bin/env node
/**
 * Backfill script: populate `requirements.metadata.git` for rows that don't
 * have it yet, derived from the requirement's latest `requirement_status.repo_url`
 * when possible, otherwise from env-var fallbacks.
 *
 * The migration 20260420_add_requirements_metadata.sql creates the column
 * (jsonb NOT NULL DEFAULT '{}'), so every row starts with `{}`. This script
 * fills in a canonical git binding so that:
 *
 *   requirements.metadata = {
 *     git: {
 *       kind: 'applications' | 'automation',
 *       org: '<github-org>',
 *       repo: '<repo-name>',
 *       default_branch: 'main',
 *       preview: { provider: 'vercel' }
 *     }
 *   }
 *
 * Idempotent: rows already containing a valid `metadata.git` are skipped.
 *
 * Usage:
 *   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   GIT_ORG=makinary GIT_APPLICATIONS_REPO=apps GIT_AUTOMATIONS_REPO=automations \
 *   node scripts/backfill-requirement-metadata-git.mjs [--dry-run] [--limit=500] [--verbose]
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[backfill] Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const VERBOSE = args.has('--verbose');
const LIMIT = (() => {
  const found = [...args].find((a) => a.startsWith('--limit='));
  if (!found) return 1000;
  const n = Number.parseInt(found.split('=')[1] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 1000;
})();

const GIT_ORG = process.env.GIT_ORG || 'makinary';
const GIT_APPLICATIONS_REPO = process.env.GIT_APPLICATIONS_REPO || 'apps';
const GIT_AUTOMATIONS_REPO = process.env.GIT_AUTOMATIONS_REPO || 'automations';
const GIT_DEFAULT_BRANCH = process.env.GIT_DEFAULT_BRANCH || 'main';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const VALID_KINDS = new Set(['applications', 'automation', 'custom']);

function isValidGitBinding(value) {
  if (!value || typeof value !== 'object') return false;
  if (typeof value.kind !== 'string' || !VALID_KINDS.has(value.kind)) return false;
  if (typeof value.org !== 'string' || !value.org.trim()) return false;
  if (typeof value.repo !== 'string' || !value.repo.trim()) return false;
  if (typeof value.default_branch !== 'string' || !value.default_branch.trim()) return false;
  return true;
}

/**
 * Parse a requirement_status.repo_url to extract { org, repo }. We accept
 * either a plain GitHub origin (`https://github.com/org/repo`) or the
 * tree-branch variant (`.../tree/<branch>`).
 */
function parseRepoUrl(repoUrl) {
  if (!repoUrl || typeof repoUrl !== 'string') return null;
  try {
    const u = new URL(repoUrl);
    if (!u.hostname.includes('github.com')) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    return { org: parts[0], repo: parts[1] };
  } catch {
    return null;
  }
}

function inferKindFromRepo(repo) {
  if (!repo) return 'applications';
  const lower = repo.toLowerCase();
  if (lower.includes('automation')) return 'automation';
  return 'applications';
}

function buildDefaultBinding(kind) {
  const repo = kind === 'automation' ? GIT_AUTOMATIONS_REPO : GIT_APPLICATIONS_REPO;
  return {
    kind,
    org: GIT_ORG,
    repo,
    default_branch: GIT_DEFAULT_BRANCH,
    preview: { provider: 'vercel' },
  };
}

/**
 * Produce a git binding for a requirement row. Prefers the latest requirement_status
 * repo_url when it parses to github.com/<org>/<repo>; falls back to env defaults.
 */
function computeBindingFor(requirement, latestStatus) {
  const parsed = parseRepoUrl(latestStatus?.repo_url);
  if (parsed) {
    const kind = inferKindFromRepo(parsed.repo);
    return {
      kind,
      org: parsed.org,
      repo: parsed.repo,
      default_branch: GIT_DEFAULT_BRANCH,
      preview: { provider: 'vercel' },
    };
  }
  const desc = [requirement.title, requirement.description].filter(Boolean).join(' ').toLowerCase();
  const kind = desc.includes('automation') ? 'automation' : 'applications';
  return buildDefaultBinding(kind);
}

async function fetchLatestStatusByRequirementId(requirementIds) {
  if (requirementIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from('requirement_status')
    .select('requirement_id, repo_url, created_at')
    .in('requirement_id', requirementIds)
    .order('created_at', { ascending: false });
  if (error) {
    console.error('[backfill] Failed reading requirement_status:', error.message);
    return new Map();
  }
  const byReq = new Map();
  for (const row of data ?? []) {
    if (!byReq.has(row.requirement_id)) byReq.set(row.requirement_id, row);
  }
  return byReq;
}

async function main() {
  console.log('[backfill] Start', { DRY_RUN, LIMIT, GIT_ORG, GIT_APPLICATIONS_REPO, GIT_AUTOMATIONS_REPO });

  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;
  let lastCreatedAt = null;

  while (true) {
    let query = supabase
      .from('requirements')
      .select('id, title, description, metadata, created_at')
      .order('created_at', { ascending: true })
      .limit(LIMIT);
    if (lastCreatedAt) query = query.gt('created_at', lastCreatedAt);

    const { data: rows, error } = await query;
    if (error) {
      console.error('[backfill] Page fetch error:', error.message);
      process.exit(2);
    }
    if (!rows || rows.length === 0) break;

    const needBinding = rows.filter((r) => {
      const existing = r.metadata && typeof r.metadata === 'object' ? r.metadata.git : undefined;
      return !isValidGitBinding(existing);
    });

    const latestStatuses = await fetchLatestStatusByRequirementId(needBinding.map((r) => r.id));

    for (const row of rows) {
      processed++;
      const existing = row.metadata && typeof row.metadata === 'object' ? row.metadata.git : undefined;
      if (isValidGitBinding(existing)) {
        skipped++;
        if (VERBOSE) console.log(`[backfill] skip ${row.id} (already has metadata.git)`);
        continue;
      }

      const binding = computeBindingFor(row, latestStatuses.get(row.id));
      const nextMetadata = { ...(row.metadata ?? {}), git: binding };

      if (DRY_RUN) {
        updated++;
        console.log(`[backfill] (dry) ${row.id} -> ${binding.kind}/${binding.org}/${binding.repo}`);
        continue;
      }

      const { error: upErr } = await supabase
        .from('requirements')
        .update({ metadata: nextMetadata })
        .eq('id', row.id);
      if (upErr) {
        errors++;
        console.error(`[backfill] update failed for ${row.id}: ${upErr.message}`);
      } else {
        updated++;
        if (VERBOSE) console.log(`[backfill] ok   ${row.id} -> ${binding.kind}/${binding.org}/${binding.repo}`);
      }
    }

    lastCreatedAt = rows[rows.length - 1].created_at;
    if (rows.length < LIMIT) break;
  }

  console.log('[backfill] Done', { processed, updated, skipped, errors, DRY_RUN });
  process.exit(errors > 0 ? 3 : 0);
}

main().catch((err) => {
  console.error('[backfill] Fatal:', err);
  process.exit(4);
});
