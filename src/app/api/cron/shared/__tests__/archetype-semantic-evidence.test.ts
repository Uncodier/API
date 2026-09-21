import { describe, expect, it } from '@jest/globals';
import { matchAcceptanceAgainstEvidence } from '../archetype-acceptance-match';
import type { BacklogItem } from '@/lib/services/requirement-backlog-types';
import type { EvidenceRecord } from '@/lib/services/requirement-ground-truth';

const item: BacklogItem = {
  id: 'profile-copy',
  title: 'Profile copy',
  kind: 'content',
  phase_id: 'content',
  status: 'in_progress',
  scope_level: 'full',
  acceptance: ['The customer profile form renders account details.'],
  attempts: 0,
  tier: 'ornamental',
};

function evidence(output: string): EvidenceRecord {
  return {
    schema_version: 1,
    item_id: item.id,
    captured_at: '2026-09-21T18:45:25.277Z',
    critic_passes: 0,
    tests: [{
      command: 'npm test',
      exit_code: 0,
      output_tail: output,
      ran_after_changes: true,
    }],
    changed_files: ['src/components/ProfileForm.tsx'],
  };
}

describe('generic semantic acceptance proof', () => {
  it('does not approve a criterion from one generic verb match', () => {
    expect(matchAcceptanceAgainstEvidence(
      item.acceptance,
      evidence('PASS unrelated layout renders'),
    )).toMatchObject({
      matched: [],
      unmatched: item.acceptance,
    });
  });

  it('accepts a receipt containing multiple criterion-specific terms', () => {
    expect(matchAcceptanceAgainstEvidence(
      item.acceptance,
      evidence('PASS customer profile form account details'),
    )).toMatchObject({
      matched: item.acceptance,
      unmatched: [],
    });
  });

  it('treats successful build evidence as a typed command proof', () => {
    const buildEvidence = evidence('PASS unrelated test');
    buildEvidence.build = {
      command: 'npm run build',
      exit_code: 0,
      duration_ms: 100,
    };

    expect(matchAcceptanceAgainstEvidence(
      ['The Next.js build succeeds.'],
      buildEvidence,
    )).toMatchObject({
      matched: ['The Next.js build succeeds.'],
      unmatched: [],
    });
  });

  it('requires the specifically requested test command to pass', () => {
    const testEvidence = evidence('PASS unrelated suite');

    expect(matchAcceptanceAgainstEvidence(
      ['Run npm test -- critical.test.ts'],
      testEvidence,
    )).toMatchObject({
      matched: [],
      unmatched: ['Run npm test -- critical.test.ts'],
    });

    testEvidence.tests![0].command = 'npm test -- critical.test.ts';
    expect(matchAcceptanceAgainstEvidence(
      ['Run npm test -- critical.test.ts'],
      testEvidence,
    )).toMatchObject({
      matched: ['Run npm test -- critical.test.ts'],
      unmatched: [],
    });
  });

  it('does not treat an imperative product request as a build command', () => {
    const buildEvidence = evidence('PASS unrelated test');
    buildEvidence.build = {
      command: 'npm run build',
      exit_code: 0,
      duration_ms: 100,
    };

    expect(matchAcceptanceAgainstEvidence(
      ['Build a dashboard'],
      buildEvidence,
    )).toMatchObject({
      matched: [],
      unmatched: ['Build a dashboard'],
    });
  });

  it('requires the method and status associated with each route', () => {
    const routeEvidence = evidence('PASS unrelated test');
    routeEvidence.observations = [
      {
        kind: 'api',
        disposition: 'pass',
        source: 'contract',
        target: '/users',
        method: 'GET',
        http_status: 200,
        detail: 'HTTP 200',
      },
      {
        kind: 'api',
        disposition: 'pass',
        source: 'contract',
        target: '/orders',
        method: 'GET',
        http_status: 200,
        detail: 'HTTP 200',
      },
    ];
    const criterion =
      'GET /users and POST /orders return 200 and 201 respectively.';

    expect(matchAcceptanceAgainstEvidence(
      [criterion],
      routeEvidence,
    )).toMatchObject({
      matched: [],
      unmatched: [criterion],
    });

    routeEvidence.observations[1] = {
      ...routeEvidence.observations[1],
      target: '/orders',
      method: 'POST',
      http_status: 201,
      detail: 'HTTP 201',
    };
    expect(matchAcceptanceAgainstEvidence(
      [criterion],
      routeEvidence,
    )).toMatchObject({
      matched: [criterion],
      unmatched: [],
    });
  });
});
