import { classifyFailure } from '@/lib/services/failure-classification';

describe('Failure Classification', () => {
  it('classifies judge verdicts as judge', () => {
    const res = classifyFailure('judge_verdict=rejected: Missing evidence');
    expect(res.failureClass).toBe('judge');
    expect(res.countsTowardAttempts).toBe(true);
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
});
