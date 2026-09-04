import { describe, expect, it } from '@jest/globals';
import { runJudge } from '../archetype-runner';
import type { BacklogItem } from '@/lib/services/requirement-backlog-types';
import type { EvidenceRecord } from '@/lib/services/requirement-ground-truth';

describe('runJudge constraint rejection', () => {
  it('rejects a doc whose evidence violates MUST NOT outbound', () => {
    const item = {
      id: 'i1',
      title: 'GTM blueprint',
      kind: 'content',
      phase_id: 'research',
      status: 'in_progress',
      scope_level: 'full',
      constraints: ['MUST NOT include outbound tactics'],
      acceptance: ['MUST NOT include outbound'],
      attempts: 0,
    } as BacklogItem;
    const evidence: EvidenceRecord = {
      schema_version: 1,
      item_id: 'i1',
      captured_at: new Date().toISOString(),
      critic_passes: 0,
      judge_reason: 'Use cold email outbound sequences to prospect founders.',
      changed_files: ['docs/gtm-channels-blueprint.md'],
    };
    const verdict = runJudge({ item, evidence, flow: 'doc' });
    expect(verdict.verdict).toBe('rejected');
    expect(verdict.reason).toMatch(/unmatched_constraints/);
  });
});
