import { describe, expect, it } from '@jest/globals';
import type { BacklogItem } from '@/lib/services/requirement-backlog-types';
import type { EvidenceRecord } from '@/lib/services/requirement-evidence-types';
import { matchOrEscalateJudgeResult } from '../archetype-judge-result';

function item(acceptance: string): BacklogItem {
  return {
    id: 'item-1',
    title: 'Acceptance diagnostics',
    kind: 'page',
    phase_id: 'build',
    acceptance: [acceptance],
    status: 'in_progress',
    attempts: 0,
    scope_level: 'full',
    tier: 'core',
  };
}

function evidence(): EvidenceRecord {
  return {
    schema_version: 1,
    item_id: 'item-1',
    captured_at: '2026-09-23T00:00:00.000Z',
    critic_passes: 0,
  };
}

describe('typed acceptance diagnostics', () => {
  it('classifies a protected success response without auth as a capability gap', () => {
    const record = evidence();
    record.observations = [{
      kind: 'api',
      disposition: 'advisory',
      source: 'contract',
      target: 'GET /api/campaigns',
      method: 'GET',
      http_status: 401,
      expected_statuses: [200],
      detail: 'HTTP 401 (unauthenticated probe reached an authentication boundary)',
    }];

    expect(matchOrEscalateJudgeResult(
      item(
        'GET /api/campaigns returns 200 and lists campaigns created by the user or their organization.',
      ),
      record,
    )).toMatchObject({
      verdict: 'escalate',
      failure_kind: 'capability_gap',
      acceptance_diagnostics: [{
        status: 'missing',
        gaps: [expect.objectContaining({
          code: 'authentication_context_missing',
          class: 'capability',
        })],
      }],
    });
  });

  it('explains when a non-GET acceptance target lacks a payload fixture', () => {
    const record = evidence();
    record.observations = [{
      kind: 'api',
      disposition: 'unknown',
      source: 'contract',
      target: 'POST /api/campaigns',
      method: 'POST',
      expected_statuses: [200],
      detail:
        'Acceptance target was not called because no request payload fixture was declared.',
    }];

    expect(matchOrEscalateJudgeResult(
      item('POST /api/campaigns returns 200 and creates a campaign.'),
      record,
    )).toMatchObject({
      verdict: 'rejected',
      failure_kind: 'evidence_gap',
      acceptance_diagnostics: [{
        gaps: [expect.objectContaining({
          code: 'missing_request_payload',
          class: 'evidence',
        })],
      }],
    });
  });

  it('classifies narrative acceptance as a contract error', () => {
    expect(matchOrEscalateJudgeResult(
      item('The campaign experience feels excellent.'),
      evidence(),
    )).toMatchObject({
      failure_kind: 'contract_error',
      acceptance_diagnostics: [{
        gaps: [expect.objectContaining({
          code: 'criterion_not_executable',
          class: 'contract',
        })],
      }],
    });
  });

  it('classifies a rejected inferred target as a contract error', () => {
    const backlogItem = item('Render the evidence input.');
    backlogItem.acceptance_contract = {
      schema_version: 1,
      criteria: [{
        id: 'criterion-1',
        text: backlogItem.acceptance[0],
        all_of: [{ kind: 'page_response', path: '/>' }],
      }],
    };
    const record = evidence();
    record.observations = [{
      kind: 'contract',
      disposition: 'unknown',
      source: 'contract_inferred',
      target: '/>',
      method: 'GET',
      detail:
        'Invalid acceptance target: Route contains whitespace, markup, quotes, or a backslash.',
      criterion_id: 'criterion-1',
      target_resolution: {
        criterion_id: 'criterion-1',
        kind: 'page',
        path: '/>',
        status: 'invalid',
        strategy: 'legacy_parser',
        required: false,
        detail: 'Route contains whitespace, markup, quotes, or a backslash.',
      },
    }];

    expect(matchOrEscalateJudgeResult(backlogItem, record)).toMatchObject({
      verdict: 'rejected',
      failure_kind: 'contract_error',
      acceptance_diagnostics: [{
        gaps: [expect.objectContaining({
          code: 'invalid_target',
          class: 'contract',
        })],
      }],
    });
  });

  it('requests contract migration when a legacy route inference fails', () => {
    const backlogItem = item('GET /campaigns returns 200.');
    const record = evidence();
    record.observations = [{
      kind: 'page',
      disposition: 'advisory',
      source: 'contract_inferred',
      target: '/campaigns',
      method: 'GET',
      http_status: 404,
      expected_statuses: [200],
      detail: 'HTTP 404',
      criterion_id: 'criterion-1',
      target_resolution: {
        criterion_id: 'criterion-1',
        kind: 'page',
        path: '/campaigns',
        status: 'legacy_inferred',
        strategy: 'legacy_parser',
        required: false,
      },
    }];

    expect(matchOrEscalateJudgeResult(backlogItem, record)).toMatchObject({
      verdict: 'rejected',
      failure_kind: 'contract_error',
      acceptance_diagnostics: [{
        gaps: [expect.objectContaining({
          code: 'inferred_target_unconfirmed',
          class: 'contract',
        })],
      }],
    });
  });

  it('uses a declared contract instead of reparsing criterion prose', () => {
    const backlogItem = item('The campaigns experience is available.');
    backlogItem.acceptance_contract = {
      schema_version: 2,
      source: 'declared',
      criteria: [{
        id: 'campaign-page',
        text: backlogItem.acceptance[0],
        all_of: [{
          kind: 'page_response',
          path: '/campaigns',
          expected_status: '200',
        }],
      }],
    };
    const record = evidence();
    record.observations = [{
      kind: 'page',
      disposition: 'pass',
      source: 'contract',
      target: '/campaigns',
      method: 'GET',
      http_status: 200,
      expected_statuses: [200],
      detail: 'HTTP 200',
    }];

    expect(matchOrEscalateJudgeResult(backlogItem, record)).toMatchObject({
      verdict: 'approved',
      matched_acceptance: backlogItem.acceptance,
    });
  });
});
