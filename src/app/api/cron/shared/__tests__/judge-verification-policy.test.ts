import { describe, expect, it } from '@jest/globals';
import {
  formatJudgeRepairFeedback,
  judgeVerificationAttemptLimit,
  verificationAttemptCount,
  verificationToolName,
} from '../judge-verification-policy';

describe('judge verification policy', () => {
  it('uses a bounded default and accepts a positive override', () => {
    expect(judgeVerificationAttemptLimit(undefined)).toBe(3);
    expect(judgeVerificationAttemptLimit('2')).toBe(2);
    expect(judgeVerificationAttemptLimit('invalid')).toBe(3);
  });

  it('keeps verification failures separate from product attempts', () => {
    expect(verificationToolName('evidence_gap'))
      .toBe('judge_evidence_collector');
    expect(verificationToolName('contract_error'))
      .toBe('judge_acceptance_contract');
    expect(verificationToolName('capability_gap'))
      .toBe('judge_capability_resolver');
    expect(verificationToolName('product_defect')).toBeNull();
    expect(verificationAttemptCount(
      {
        evidence_collector: 163,
        judge_evidence_collector: 1,
      },
      'judge_evidence_collector',
    )).toBe(1);
  });

  it('produces actionable repair feedback with exact unmatched criteria', () => {
    const feedback = formatJudgeRepairFeedback({
      verdict: 'rejected',
      failure_kind: 'evidence_gap',
      reason: 'One criterion lacks proof.',
      matched_acceptance: ['GET / returns 200'],
      unmatched_acceptance: ['Footer links resolve without errors'],
    });

    expect(feedback).toContain('Failure kind: evidence_gap');
    expect(feedback).toContain('Footer links resolve without errors');
    expect(feedback).toContain('evidence-collection turn is read-only');
    expect(feedback).toContain('report it as a product defect');
    expect(feedback).toContain('Do not repeat an identical probe');
  });

  it('includes machine-readable gap diagnostics in retry feedback', () => {
    const feedback = formatJudgeRepairFeedback({
      verdict: 'escalate',
      failure_kind: 'capability_gap',
      reason: 'Authenticated evidence is unavailable.',
      matched_acceptance: [],
      unmatched_acceptance: ['GET /api/account returns 200'],
      acceptance_diagnostics: [{
        criterion_id: 'criterion-1',
        criterion: 'GET /api/account returns 200',
        status: 'missing',
        claims: [],
        gaps: [{
          code: 'authentication_context_missing',
          class: 'capability',
          message: 'No authenticated context.',
          required: 'GET /api/account returns 200',
          observed: ['GET /api/account returned 401'],
          suggested_action: 'Configure an auth profile.',
        }],
      }],
    });

    expect(feedback).toContain('Structured evidence gaps:');
    expect(feedback).toContain('"code": "authentication_context_missing"');
    expect(feedback).toContain('Keep this item quarantined');
  });
});
