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
});
