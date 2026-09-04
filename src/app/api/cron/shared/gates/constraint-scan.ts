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

/** Hunks for this-step files; full-file scan for leftovers (stale git-rm path). */
export function splitScanTargets(
  allFiles: string[],
  touchedFiles: Iterable<string>,
): { hunkFiles: string[]; staleFiles: string[] } {
  const touched = new Set(
    Array.from(touchedFiles, (f) => String(f || '').trim().replace(/^\.\//, '')).filter(Boolean),
  );
  const hunkFiles: string[] = [];
  const staleFiles: string[] = [];
  for (let i = 0; i < allFiles.length; i++) {
    const file = String(allFiles[i] || '').trim().replace(/^\.\//, '');
    if (!file) continue;
    if (touched.has(file)) hunkFiles.push(file);
    else staleFiles.push(file);
  }
  return { hunkFiles, staleFiles };
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
  return countResearchCitations(text);
}

/** Counts unique http(s) URLs, including markdown `[text](url)` links. */
export function countResearchCitations(text: string): number {
  const urls = new Set<string>();
  const hay = String(text || '');
  const bare = hay.match(/https?:\/\/[^\s"'`)>\]]+/gi) || [];
  for (let i = 0; i < bare.length; i++) {
    urls.add(bare[i].replace(/[.,;:]+$/, ''));
  }
  const md = hay.match(/\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/gi) || [];
  for (let i = 0; i < md.length; i++) {
    const inner = md[i].match(/\((https?:\/\/[^)\s]+)\)/i);
    if (inner) urls.add(inner[1]);
  }
  return urls.size;
}

export function extractNamedMarkdownPaths(...blocks: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const re = /(?:docs|artifacts|reports|outputs)\/[\w./-]+\.mdx?/gi;
  for (let i = 0; i < blocks.length; i++) {
    const raw = blocks[i];
    if (!raw) continue;
    const matches = String(raw).match(re) || [];
    for (let j = 0; j < matches.length; j++) {
      const name = matches[j].replace(/^\.\//, '');
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

export function resolveResearchCitationTargets(opts: {
  existingMarkdown: string[];
  namedInStep: string[];
  touchedThisStep?: Iterable<string>;
}): { files: string[]; missing: boolean } {
  const existing = new Set(
    opts.existingMarkdown.map((f) => String(f || '').trim().replace(/^\.\//, '')).filter(Boolean),
  );
  const named = opts.namedInStep.filter((f) => existing.has(f));
  const investigations = Array.from(existing).filter(
    (f) => f.startsWith('docs/investigations/') && /\.mdx?$/i.test(f),
  );
  const touched: string[] = [];
  if (opts.touchedThisStep) {
    for (const raw of opts.touchedThisStep) {
      const f = String(raw || '').trim().replace(/^\.\//, '');
      if (f && /\.mdx?$/i.test(f) && existing.has(f)) touched.push(f);
    }
  }
  const files = uniqueHitFiles(
    [...named, ...investigations, ...touched].map((file) => ({ constraint: '', term: '', quote: '', file })),
  );
  if (files.length) return { files, missing: false };
  return { files: [], missing: true };
}

/** Added lines from a unified diff (ignores `+++` headers). */
export function extractAddedDiffLines(diff: string): string {
  const added: string[] = [];
  const lines = String(diff || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('+') && !line.startsWith('+++')) {
      added.push(line.slice(1));
    }
  }
  return added.join('\n');
}

export function formatInheritedConstraintHint(hits: ConstraintHit[]): string {
  if (!hits.length) return '';
  const files = uniqueHitFiles(hits).slice(0, 6).join(', ');
  return `Inherited constraint text in ${files} (pre-existing line, not in this-step diff). Rewrite that line or leave it — this does not consume an attempt.`;
}

export function formatResearchCitationHint(found: number, required: number = MIN_RESEARCH_HTTPS): string {
  return `Research gate: add at least ${required} https:// citations in the written markdown (found ${found}). Use webSearch and paste real URLs next to each community/forum name.`;
}

/** Cron's finally commit often `git add -A` leftover docs — do not treat those as this-step writes. */
export function isHarnessCycleCommit(subject: string): boolean {
  return /cron cycle complete/i.test(String(subject || ''));
}
