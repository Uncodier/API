import {
  countHttpsCitations,
  formatConstraintRetryHint,
  formatResearchCitationHint,
  isHarnessCycleCommit,
  isSafeArtifactPath,
  parseFileNameList,
  partitionConstraintHits,
  shouldRequireResearchCitations,
  uniqueHitFiles,
} from '../constraint-scan';

describe('constraint-scan', () => {
  it('parses unique artifact paths', () => {
    const names = parseFileNameList(
      'docs/a.md\n./docs/a.md\nsrc/app/page.tsx\ndocs/b.json\n\n',
    );
    expect(names).toEqual(['docs/a.md', 'docs/b.json']);
  });

  it('only allows docs/artifacts/reports/outputs paths', () => {
    expect(isSafeArtifactPath('docs/gtm-channels-blueprint.md')).toBe(true);
    expect(isSafeArtifactPath('artifacts/out.json')).toBe(true);
    expect(isSafeArtifactPath('../docs/x.md')).toBe(false);
    expect(isSafeArtifactPath('src/app/layout.tsx')).toBe(false);
  });

  it('treats leftover docs as stale when this step only touched the new file', () => {
    const hits = [
      { constraint: 'no outbound', term: 'outbound', quote: 'outbound copy', file: 'docs/gtm-channels-blueprint.md' },
      { constraint: 'no outbound', term: 'cold email', quote: 'cold email', file: 'docs/investigations/channels-research.md' },
    ];
    const { touchedHits, staleHits } = partitionConstraintHits(hits, [
      'docs/investigations/channels-research.md',
    ]);
    expect(staleHits.map((h) => h.file)).toEqual(['docs/gtm-channels-blueprint.md']);
    expect(touchedHits.map((h) => h.file)).toEqual(['docs/investigations/channels-research.md']);
    expect(uniqueHitFiles(staleHits)).toEqual(['docs/gtm-channels-blueprint.md']);
  });

  it('passes when only stale leftovers violate and the new file is clean', () => {
    const hits = [
      { constraint: 'no outbound', term: 'outbound', quote: 'outbound', file: 'docs/gtm-channels-blueprint.md' },
    ];
    const { touchedHits, staleHits } = partitionConstraintHits(hits, [
      'docs/investigations/channels-research.md',
    ]);
    expect(touchedHits).toHaveLength(0);
    expect(staleHits).toHaveLength(1);
  });

  it('formats a rewrite hint with path and quote', () => {
    const hint = formatConstraintRetryHint([
      {
        constraint: 'MUST NOT outbound',
        term: 'outbound',
        quote: 'use outbound sequences',
        file: 'docs/gtm.md',
      },
    ]);
    expect(hint).toContain('Rewrite docs/gtm.md');
    expect(hint).toContain('outbound');
    expect(hint).toContain('use outbound sequences');
  });

  it('requires research citations for research-like steps', () => {
    expect(shouldRequireResearchCitations('Deep Research: Verticals 1-4', 'use webSearch')).toBe(true);
    expect(shouldRequireResearchCitations('Add login page', 'implement auth')).toBe(false);
    expect(countHttpsCitations('See https://ampi.org.mx and https://reddit.com/r/x')).toBe(2);
    expect(formatResearchCitationHint(0)).toContain('https://');
    expect(isHarnessCycleCommit('Cron cycle complete (with failures): Research')).toBe(true);
    expect(isHarnessCycleCommit('[checkpoint] Added research data')).toBe(false);
  });
});
