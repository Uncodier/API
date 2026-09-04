/**
 * Pure helpers for the constraint gate: classify stale vs this-step files,
 * format retry hints, and research-citation checks. No sandbox I/O.
 */

export type ConstraintHit = {
  constraint: string;
  term: string;
  quote: string;
  file?: string;
  stale?: boolean;
};

const ARTIFACT_EXT = /\.(md|mdx|txt|json)$/i;
const SAFE_PREFIX = /^(docs|artifacts|reports|outputs)\//;
export const RESEARCH_STEP_RE =
  /research|investigat|comunidad|communities|canales|channel|marketplace|foro|forum/i;
export const MIN_RESEARCH_HTTPS = 3;

export function parseFileNameList(stdout: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of String(stdout || '').split('\n')) {
    const name = raw.trim().replace(/^\.\//, '');
    if (!name || !ARTIFACT_EXT.test(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export function isSafeArtifactPath(file: string): boolean {
  const name = String(file || '').trim().replace(/^\.\//, '');
  if (!name || name.includes('..') || name.startsWith('/')) return false;
  return SAFE_PREFIX.test(name);
}

export function partitionConstraintHits(
  hits: ConstraintHit[],
  touchedFiles: Iterable<string>,
): { touchedHits: ConstraintHit[]; staleHits: ConstraintHit[] } {
  const touched = new Set(
    Array.from(touchedFiles, (f) => String(f || '').trim().replace(/^\.\//, '')).filter(Boolean),
  );
  const touchedHits: ConstraintHit[] = [];
  const staleHits: ConstraintHit[] = [];
  for (const hit of hits) {
    const file = String(hit.file || '').trim().replace(/^\.\//, '');
    if (file && touched.has(file)) {
      touchedHits.push({ ...hit, file, stale: false });
    } else {
      staleHits.push({ ...hit, file: file || hit.file, stale: true });
    }
  }
  return { touchedHits, staleHits };
}

export function uniqueHitFiles(hits: ConstraintHit[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const hit of hits) {
    const file = String(hit.file || '').trim().replace(/^\.\//, '');
    if (!file || seen.has(file)) continue;
    seen.add(file);
    out.push(file);
  }
  return out;
}

export function formatConstraintRetryHint(hits: ConstraintHit[]): string {
  if (!hits.length) return '';
  const lines = hits.slice(0, 8).map((h) => {
    const file = h.file || 'unknown file';
    const quote = String(h.quote || '').slice(0, 80);
    return `Rewrite ${file}: forbidden "${h.term}" near "${quote}"`;
  });
  return [
    'Constraint gate failed on files you changed this step.',
    'Remove or rewrite the forbidden terms in those files (do not leave leftover outbound copy).',
    ...lines,
  ].join('\n');
}

export function shouldRequireResearchCitations(...blocks: Array<string | null | undefined>): boolean {
  return RESEARCH_STEP_RE.test(blocks.filter(Boolean).join(' '));
}

export function countHttpsCitations(text: string): number {
  const matches = String(text || '').match(/https:\/\/[^\s"'`)>\]]+/gi);
  return matches ? matches.length : 0;
}

export function formatResearchCitationHint(found: number, required: number = MIN_RESEARCH_HTTPS): string {
  return `Research gate: add at least ${required} https:// citations in the written markdown (found ${found}). Use webSearch and paste real URLs next to each community/forum name.`;
}

/** Cron's finally commit often `git add -A` leftover docs — do not treat those as this-step writes. */
export function isHarnessCycleCommit(subject: string): boolean {
  return /cron cycle complete/i.test(String(subject || ''));
}
