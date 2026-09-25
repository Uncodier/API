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

  it('does not accept criterion-specific words from test output', () => {
    expect(matchAcceptanceAgainstEvidence(
      item.acceptance,
      evidence('PASS customer profile form account details'),
    )).toMatchObject({
      matched: [],
      unmatched: item.acceptance,
    });
  });

  it('does not accept criterion-specific words from a scenario name', () => {
    const scenarioEvidence = evidence('PASS unrelated test');
    scenarioEvidence.scenarios = [{
      name: 'customer profile form account details',
      pass: true,
      duration_ms: 5,
    }];

    expect(matchAcceptanceAgainstEvidence(
      item.acceptance,
      scenarioEvidence,
    )).toMatchObject({
      matched: [],
      unmatched: item.acceptance,
    });
  });

  it('accepts a browser-backed structured assertion', () => {
    const browserEvidence = evidence('PASS unrelated test');
    browserEvidence.scenario_assertions = [{
      kind: 'dom_assertion',
      criterion_id: 'criterion-1',
      pass: true,
      selector: '[data-testid="customer-profile-form"]',
      assertion: 'text_contains',
      expected: 'Customer profile form account details',
      actual: 'Customer profile form Account details',
    }];

    expect(matchAcceptanceAgainstEvidence(
      item.acceptance,
      browserEvidence,
      {
        schema_version: 1,
        criteria: [{
          id: 'criterion-1',
          text: item.acceptance[0],
          all_of: [{
            kind: 'semantic_assertion',
            text: item.acceptance[0],
          }],
        }],
      },
    )).toMatchObject({
      matched: item.acceptance,
      unmatched: [],
    });
  });

  it('does not use a scenario assertion bound to another criterion', () => {
    const browserEvidence = evidence('');
    browserEvidence.scenario_assertions = [{
      kind: 'dom_assertion',
      criterion_id: 'other-criterion',
      pass: true,
      selector: '[data-testid="customer-profile-form"]',
      assertion: 'text_contains',
      actual: 'Customer profile Account details',
    }];

    expect(matchAcceptanceAgainstEvidence(
      item.acceptance,
      browserEvidence,
      {
        schema_version: 1,
        criteria: [{
          id: 'criterion-1',
          text: item.acceptance[0],
          all_of: [{
            kind: 'semantic_assertion',
            text: item.acceptance[0],
          }],
        }],
      },
    )).toMatchObject({ matched: [], unmatched: item.acceptance });
  });

  it('does not trust authored expected text when the browser observed something else', () => {
    const browserEvidence = evidence('PASS unrelated test');
    browserEvidence.scenario_assertions = [{
      kind: 'dom_assertion',
      criterion_id: 'criterion-1',
      pass: true,
      selector: '[data-testid="customer-profile-form-account-details"]',
      assertion: 'text_contains',
      expected: 'Customer profile account details',
      actual: 'Loading',
    }];

    expect(matchAcceptanceAgainstEvidence(
      item.acceptance,
      browserEvidence,
    )).toMatchObject({
      matched: [],
      unmatched: item.acceptance,
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

  it('does not accept an API route from matching test output alone', () => {
    const routeEvidence = evidence('PASS POST /api/contact 201');
    routeEvidence.changed_files = ['src/app/api/contact/route.ts'];

    expect(matchAcceptanceAgainstEvidence(
      ['POST /api/contact returns 201.'],
      routeEvidence,
    )).toMatchObject({
      matched: [],
      unmatched: ['POST /api/contact returns 201.'],
    });
  });

  it('requires every claim in an all_of criterion', () => {
    const criterion = 'Footer links to docs and creates docs/index.md.';
    const linkEvidence = evidence('PASS unrelated test');
    linkEvidence.interaction = {
      evaluable: true,
      links: [{
        target: '/docs',
        region: 'footer',
        route_exists: true,
        content_excerpt: 'Documentation',
      }],
      unresolved_links: [],
      findings: [],
    } as any;
    linkEvidence.observations = [{
      kind: 'page',
      disposition: 'pass',
      source: 'contract',
      target: '/docs',
      detail: 'HTTP 200',
      http_status: 200,
    }];
    linkEvidence.feature_coverage = {
      artifact_proofs: [],
    } as any;

    expect(matchAcceptanceAgainstEvidence(
      [criterion],
      linkEvidence,
      {
        schema_version: 2,
        source: 'declared',
        criteria: [{
          id: 'docs-link-and-file',
          text: criterion,
          all_of: [
            {
              kind: 'internal_link',
              path: '/docs',
              region: 'footer',
              requires_content: true,
            },
            {
              kind: 'file_artifact',
              path: 'docs/index.md',
            },
          ],
        }],
      },
    )).toMatchObject({
      matched: [],
      unmatched: [criterion],
    });
  });

  it('does not treat a blank command as proof from any passing test', () => {
    const criterion = 'Run the required verification.';

    expect(matchAcceptanceAgainstEvidence(
      [criterion],
      evidence('PASS unrelated test'),
      {
        schema_version: 1,
        criteria: [{
          id: 'blank-command',
          text: criterion,
          all_of: [{ kind: 'command', command: '   ' }],
        }],
      },
    )).toMatchObject({
      matched: [],
      unmatched: [criterion],
    });
  });

  it('matches a concrete internal link against a route template', () => {
    const criterion = 'Navigation links to a documentation page.';
    const linkEvidence = evidence('PASS unrelated test');
    linkEvidence.interaction = {
      evaluable: true,
      links: [{
        target: '/docs/getting-started',
        region: 'navigation',
        route_exists: true,
        content_excerpt: 'Getting started',
      }],
      unresolved_links: [],
      findings: [],
    } as any;
    linkEvidence.observations = [{
      kind: 'page',
      disposition: 'pass',
      source: 'contract',
      target: '/docs/getting-started',
      detail: 'HTTP 200',
      http_status: 200,
    }];

    expect(matchAcceptanceAgainstEvidence(
      [criterion],
      linkEvidence,
      {
        schema_version: 2,
        source: 'declared',
        criteria: [{
          id: 'documentation-link',
          text: criterion,
          all_of: [{
            kind: 'internal_link',
            path: '/docs/[slug]',
            region: 'navigation',
            requires_content: true,
          }],
        }],
      },
    )).toMatchObject({
      matched: [criterion],
      unmatched: [],
    });
  });

  it('matches concrete evidence against a Next.js route template', () => {
    const criterion = 'GET /api/assets/[id] returns 200.';
    const routeEvidence = evidence('PASS unrelated test');
    routeEvidence.observations = [{
      kind: 'api',
      disposition: 'pass',
      source: 'contract',
      target: 'GET /api/assets/123',
      method: 'GET',
      http_status: 200,
      detail: 'HTTP 200',
    }];

    expect(matchAcceptanceAgainstEvidence(
      [criterion],
      routeEvidence,
      {
        schema_version: 2,
        source: 'declared',
        criteria: [{
          id: 'asset-detail',
          text: criterion,
          all_of: [{
            kind: 'http_response',
            path: '/api/assets/[id]',
            method: 'GET',
            expected_status: '200',
            auth: 'unspecified',
          }],
        }],
      },
    )).toMatchObject({
      matched: [criterion],
      unmatched: [],
    });
  });

  it('does not let an unbound agent probe resolve a contractual unknown', () => {
    const criterion = 'POST /api/orders returns 201.';
    const probeEvidence = evidence('');
    probeEvidence.observations = [{
      kind: 'api',
      disposition: 'pass',
      source: 'agent_probe',
      target: 'POST /api/orders',
      method: 'POST',
      http_status: 201,
      detail: 'HTTP 201',
    }];
    const contract = {
      schema_version: 2 as const,
      source: 'declared' as const,
      criteria: [{
        id: 'create-order',
        text: criterion,
        all_of: [{
          kind: 'http_response' as const,
          path: '/api/orders',
          method: 'POST' as const,
          expected_status: '201',
          auth: 'unspecified' as const,
        }],
      }],
    };

    expect(matchAcceptanceAgainstEvidence(
      [criterion],
      probeEvidence,
      contract,
    )).toMatchObject({ matched: [], unmatched: [criterion] });

    probeEvidence.observations[0].criterion_id = 'create-order';
    expect(matchAcceptanceAgainstEvidence(
      [criterion],
      probeEvidence,
      contract,
    )).toMatchObject({ matched: [criterion], unmatched: [] });
  });
});
