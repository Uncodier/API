import { describe, expect, it } from '@jest/globals';
import {
  extractRequirementConstraints,
  findConstraintViolations,
  formatConstraintsPromptBlock,
} from '@/lib/services/requirement-constraints';

describe('requirement constraints', () => {
  it('extracts MUST NOT / sin outbound lines', () => {
    const spec = `
## Constraints
- MUST NOT include outbound tactics
- sin prospección en frío
## Other
- ship a blueprint
`;
    const constraints = extractRequirementConstraints(spec);
    expect(constraints.length).toBeGreaterThanOrEqual(2);
    expect(constraints.some((c) => /outbound/i.test(c.text))).toBe(true);
    expect(constraints.some((c) => c.forbiddenTerms.includes('outbound'))).toBe(true);
  });

  it('flags outbound-style copy as a violation', () => {
    const constraints = extractRequirementConstraints('MUST NOT include outbound or cold email');
    const hits = findConstraintViolations(
      'Use a cold email sequence for outbound prospection this week.',
      constraints,
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].term).toMatch(/outbound|cold email|prospecci/i);
  });

  it('extracts proper nouns from a non-outbound MUST NOT, not generic words', () => {
    const constraints = extractRequirementConstraints('MUST NOT mention CompetitorX in the blueprint');
    const terms = constraints.flatMap((c) => c.forbiddenTerms);
    expect(terms.some((t) => /competitorx/i.test(t))).toBe(true);
    expect(terms.some((t) => /blueprint/i.test(t))).toBe(false);
    const hits = findConstraintViolations('We recommend CompetitorX as the primary channel.', constraints);
    expect(hits.some((h) => /competitorx/i.test(h.term))).toBe(true);
    const generic = findConstraintViolations('This research blueprint covers communities only.', constraints);
    expect(generic.every((h) => !/blueprint/i.test(h.term))).toBe(true);
  });

  it('treats solo comunidades as outbound-forbidden, not community-forbidden', () => {
    const constraints = extractRequirementConstraints('solo comunidades, sin outbound');
    expect(constraints.some((c) => c.forbiddenTerms.includes('outbound'))).toBe(true);
    const communityHits = findConstraintViolations('Work only with existing communities.', constraints);
    expect(communityHits.every((h) => !/comunidad|community/i.test(h.term))).toBe(true);
  });

  it('formats a CRITICAL CONSTRAINTS prompt block', () => {
    const block = formatConstraintsPromptBlock(
      extractRequirementConstraints('MUST NOT do outbound'),
    );
    expect(block).toContain('CRITICAL CONSTRAINTS');
    expect(block).toContain('MUST NOT do outbound');
  });
});
