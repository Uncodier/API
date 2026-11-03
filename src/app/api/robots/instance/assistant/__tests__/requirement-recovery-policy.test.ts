import { requirementRecoveryPolicy, REQUIREMENT_RECOVERY_GUIDANCE } from '../requirement-recovery-policy';
import type { HarnessTool } from '@/lib/harness/types';

test('action-specific host policy uses nested routed arguments, never model recovery claims', () => {
  const choose = jest.fn((args: Record<string, unknown>) => args.action === 'replace' ? 'inspect' as const : 'verify_external' as const);
  const tool: HarnessTool = { name: 'document', effect: 'write', description: '', parameters: {}, recoveryPolicy: choose,
    execute: jest.fn() };
  const tools = new Map([[tool.name, tool]]);
  for (const args of [{ action: 'replace' }, JSON.stringify({ action: 'replace' })]) {
    expect(requirementRecoveryPolicy('tools', { action: 'call', name: tool.name, args, recoveryPolicy: 'retry_safe' }, tools)).toBe('inspect');
    expect(choose).toHaveBeenLastCalledWith({ action: 'replace' });
  }
  expect(requirementRecoveryPolicy(tool.name, { action: 'create', recoveryPolicy: 'retry_safe' }, tools)).toBe('verify_external');
  expect(requirementRecoveryPolicy('unknown', { recoveryPolicy: 'retry_safe' }, tools)).toBe('verify_external');
  for (const args of ['{', 'null', '[]', null]) {
    choose.mockClear();
    expect(requirementRecoveryPolicy('tools', { action: 'call', name: tool.name, args }, tools)).toBe('verify_external');
    expect(choose).not.toHaveBeenCalled();
  }
  expect(tool.execute).not.toHaveBeenCalled();
});

test('policy guidance uses normal history and inspection rather than a required reconciler', () => {
  expect(REQUIREMENT_RECOVERY_GUIDANCE).toContain('paginated history');
  expect(REQUIREMENT_RECOVERY_GUIDANCE).toContain('partially applied batches');
  expect(REQUIREMENT_RECOVERY_GUIDANCE).not.toContain('reconcile_operation');
  expect(REQUIREMENT_RECOVERY_GUIDANCE).toContain('Continue independent work');
});