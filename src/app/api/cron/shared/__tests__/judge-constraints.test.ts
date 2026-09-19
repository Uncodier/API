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

  it('does not require Jest evidence for every core page', () => {
    const item = {
      id: 'page-1',
      title: 'Profile page',
      kind: 'page',
      phase_id: 'build',
      status: 'in_progress',
      scope_level: 'full',
      acceptance: ['GET /profile returns 200'],
      attempts: 0,
      tier: 'core',
    } as BacklogItem;
    const evidence: EvidenceRecord = {
      schema_version: 1,
      item_id: item.id,
      captured_at: new Date().toISOString(),
      critic_passes: 0,
      build: { command: 'npm run build', exit_code: 0, duration_ms: 1 },
      runtime: { route: '/profile', http_status: 200 },
      changed_files: ['src/app/profile/page.tsx'],
    };

    const verdict = runJudge({ item, evidence, flow: 'app' });

    expect(verdict.reason).not.toContain('requires successful test evidence');
  });

  it('still requires tests for explicit API work', () => {
    const item = {
      id: 'api-1',
      title: 'Create asset API',
      kind: 'api',
      phase_id: 'build',
      status: 'in_progress',
      scope_level: 'full',
      acceptance: ['POST /api/assets returns 201'],
      attempts: 0,
      tier: 'core',
    } as BacklogItem;
    const evidence: EvidenceRecord = {
      schema_version: 1,
      item_id: item.id,
      captured_at: new Date().toISOString(),
      critic_passes: 0,
      build: { command: 'npm run build', exit_code: 0, duration_ms: 1 },
      runtime: { route: '/api/assets', http_status: 201 },
      changed_files: ['src/app/api/assets/route.ts'],
    };

    const verdict = runJudge({ item, evidence, flow: 'app' });

    expect(verdict.reason).toContain('requires successful test evidence');
  });
});
