import { classifyFailure } from '@/lib/services/failure-classification';

describe('Failure Classification', () => {
  it('does not consume attempts for inherited-line constraint hits', () => {
    const res = classifyFailure('inherited constraint on a pre-existing line', undefined, {
      flow: 'makinari',
      signals: [{ name: 'constraints', ok: false }],
      skipAttemptBump: true,
    });
    expect(res.failureClass).toBe('plumbing');
    expect(res.countsTowardAttempts).toBe(false);
  });

  it('classifies missing Judge receipts as evidence gaps', () => {
    const res = classifyFailure('judge_verdict=rejected: Missing evidence');
    expect(res.failureClass).toBe('evidence');
    expect(res.countsTowardAttempts).toBe(false);
  });

  it('keeps invalid acceptance targets outside the product budget', () => {
    const res = classifyFailure(
      'Invalid acceptance target: route contains markup.',
    );
    expect(res.failureClass).toBe('contract');
    expect(res.toolName).toBe('acceptance_contract');
    expect(res.countsTowardAttempts).toBe(false);
  });

  it('classifies build failures as product', () => {
    const res = classifyFailure('gate_failed: npm run build failed');
    expect(res.failureClass).toBe('product');
    expect(res.countsTowardAttempts).toBe(true);
  });

  it('classifies runtime failures as product', () => {
    const res = classifyFailure('gate_failed: Runtime probe failed — runtime FAIL');
    expect(res.failureClass).toBe('product');
    expect(res.countsTowardAttempts).toBe(true);
  });

  it('classifies explicit categories as product', () => {
    const res = classifyFailure('Something broke', ['api', 'runtime']);
    expect(res.failureClass).toBe('product');
    expect(res.category).toBe('api');
    expect(res.countsTowardAttempts).toBe(true);
  });

  it('classifies tool serialization bugs as plumbing', () => {
    const res = classifyFailure('Expected array, received string in tool instance_plan');
    expect(res.failureClass).toBe('plumbing');
    expect(res.countsTowardAttempts).toBe(false);
    expect(res.toolName).toBe('instance_plan');
  });

  it('classifies sandbox crash as plumbing', () => {
    const res = classifyFailure('Tool sandbox_run_command failed: 410 Gone');
    expect(res.failureClass).toBe('plumbing');
    expect(res.countsTowardAttempts).toBe(false);
    expect(res.toolName).toBe('sandbox_run_command');
  });

  it('classifies gate signals as product and never unknown', () => {
    const res = classifyFailure('Gate step 1 failed', undefined, {
      flow: 'doc',
      signals: [{ name: 'has-markdown', ok: false }],
    });
    expect(res.failureClass).toBe('product');
    expect(res.toolName).toBe('has-markdown');
    expect(res.toolName?.toLowerCase()).not.toBe('unknown');
  });

  it('classifies origin-only gate signals as plumbing', () => {
    const res = classifyFailure('rebase conflict', undefined, {
      flow: 'task',
      signals: [{ name: 'origin', ok: false }],
    });
    expect(res.failureClass).toBe('plumbing');
    expect(res.toolName).toBe('origin');
    expect(res.countsTowardAttempts).toBe(false);
  });

  it('does not let a generic product label override origin-only evidence', () => {
    const res = classifyFailure('Origin push not verified', undefined, {
      flow: 'app',
      failureKind: 'product_defect',
      signals: [{ name: 'origin', ok: false }],
    });
    expect(res.failureClass).toBe('plumbing');
    expect(res.countsTowardAttempts).toBe(false);
  });

  it('uses typed precondition failures without consuming attempts', () => {
    const res = classifyFailure('Gate failed', undefined, {
      flow: 'app',
      failureKind: 'missing_precondition',
      signals: [],
    });
    expect(res.failureClass).toBe('precondition');
    expect(res.countsTowardAttempts).toBe(false);
  });

  it('never persists tool=unknown for a generic execute_step error', () => {
    const res = classifyFailure('Tool unknown failed: missing step_id');
    expect(res.toolName).toBe('instance_plan');
    expect(res.toolName?.toLowerCase()).not.toBe('unknown');
  });

  it('labels generic plumbing as sandbox, not instance_plan', () => {
    const res = classifyFailure('Command failed: ETIMEDOUT connecting to host');
    expect(res.failureClass).toBe('plumbing');
    expect(res.toolName).toBe('sandbox');
    expect(res.toolName).not.toBe('instance_plan');
  });
});
