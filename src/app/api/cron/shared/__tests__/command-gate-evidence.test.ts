import { beforeEach, describe, expect, it } from '@jest/globals';
import type { CommandEvidenceSignal, EvidenceRecord } from '@/lib/services/requirement-evidence-types';
import { prepareSingleTurnGateEvidence } from '../single-turn-gate-evidence';
import { writeEvidence } from '@/lib/services/requirement-ground-truth';

jest.mock('@/lib/services/requirement-ground-truth', () => ({ writeEvidence: jest.fn() }));
const mockWriteEvidence = writeEvidence as jest.Mock;
jest.mock('@/lib/services/sandbox-service', () => ({ SandboxService: { WORK_DIR: '/vercel/sandbox' } }));

function command(overrides: Partial<CommandEvidenceSignal> = {}): CommandEvidenceSignal {
  return {
    command: 'npm run lint', exit_code: 0, output_tail: 'No lint findings',
    ran_after_changes: true, captured_at: '2026-10-01T00:00:00.000Z',
    step_id: 'step-1', workspace_fingerprint: 'workspace-1', ...overrides,
  };
}

function base() {
  return {
    sandbox: {} as any, cwd: '/vercel/sandbox', requirementId: 'requirement-1',
    backlogItemId: 'item-1', stepId: 'step-1', result: {},
    validatedFingerprint: 'workspace-1', workspaceFingerprint: 'workspace-1',
    transientGateFailure: false,
  };
}

function toolResult(options: {
  signal?: CommandEvidenceSignal;
  receipt?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  isError?: boolean;
  toolName?: string;
} = {}) {
  return { steps: [{
    toolCalls: [{ id: 'call-1', toolName: options.toolName || 'sandbox_run_validation' }],
    toolResults: [{ toolCallId: 'call-1', isError: options.isError, result: {
      success: true, receipt: {
        kind: 'command_execution', requirement_id: 'requirement-1', item_id: 'item-1',
        step_id: 'step-1', workspace_fingerprint: 'workspace-1',
        commands: [options.signal || command()], ...options.receipt,
      }, ...options.payload,
    } }],
  }] };
}

describe('single-turn gate command evidence', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('reuses only current canonical commands in a fresh evidence run without inventing tests', async () => {
    const backlogEvidence: EvidenceRecord = {
      schema_version: 1, item_id: 'item-1', captured_at: '2026-10-01T00:00:00.000Z',
      critic_passes: 0, evidence_run_id: 'previous-run',
      commands: [command(), command({ command: 'npm run build', workspace_fingerprint: 'old-workspace' }),
        command({ command: 'npm run typecheck', step_id: 'old-step' })],
    };
    const result = await prepareSingleTurnGateEvidence({ ...base(), backlogEvidence });
    expect(result.commands).toEqual([command()]);
    expect(result.tests).toEqual([]);
    expect(result.evidenceRunId).not.toBe('previous-run');
    expect(mockWriteEvidence).toHaveBeenCalledWith(expect.objectContaining({ record: expect.objectContaining({
      commands: [command()], tests: [], evidence_provenance: {
        mode: 'reused', reused_from_evidence_run_ids: ['previous-run'],
      },
    }) }));
  });

  it('promotes the exact scoped tool receipt into commands, never tests', async () => {
    const result = await prepareSingleTurnGateEvidence({ ...base(), result: toolResult() });
    expect(result.commands).toEqual([command()]);
    expect(result.tests).toEqual([]);
    expect(mockWriteEvidence).toHaveBeenCalledWith(expect.objectContaining({ record: expect.objectContaining({
      commands: [command()], tests: [], producer_step_id: 'step-1', workspace_fingerprint: 'workspace-1',
    }) }));
  });

  it('preserves completed nonzero product receipts for contradiction', async () => {
    const receipt = command({ exit_code: 1 });
    const result = await prepareSingleTurnGateEvidence({ ...base(), result: toolResult({ signal: receipt,
      payload: { success: false, code: 'VALIDATION_PRODUCT_FAILURE', error: 'Validation exited with code 1' },
    }) });
    expect(result.commands).toEqual([receipt]);
  });

  it.each([
    { isError: true },
    { payload: { success: false, error: 'Transport disconnected' } },
    { receipt: { requirement_id: 'wrong-requirement' } },
    { receipt: { item_id: 'wrong-item' } },
    { receipt: { step_id: 'wrong-step' } },
    { receipt: { workspace_fingerprint: 'stale-workspace' } },
    { signal: command({ workspace_fingerprint: 'stale-workspace' }) },
    { signal: command({ step_id: 'stale-step' }) },
    { signal: command({ ran_after_changes: false }) },
    { signal: command({ exit_code: Number.NaN }) },
    { toolName: 'sandbox_run_command' },
  ])('does not promote stale, forged or transport error receipts: %j', async (options) => {
    const result = await prepareSingleTurnGateEvidence({ ...base(), result: toolResult(options) });
    expect(result.commands).toEqual([]);
    expect(result.tests).toEqual([]);
    expect(mockWriteEvidence).not.toHaveBeenCalled();
  });

  it('requires a validated fingerprint and rejects another backlog item canonical evidence', async () => {
    const result = await prepareSingleTurnGateEvidence({ ...base(), validatedFingerprint: undefined,
      result: toolResult(), backlogEvidence: {
        schema_version: 1, item_id: 'another-item', captured_at: command().captured_at,
        critic_passes: 0, commands: [command()],
      },
    });
    expect(result.commands).toEqual([]);
  });

  it('rejects receipts collected before a later workspace write', async () => {
    const result = toolResult();
    result.steps.push({ toolCalls: [{ id: 'edit-1', toolName: 'sandbox_edit_file' }], toolResults: [] });
    expect((await prepareSingleTurnGateEvidence({ ...base(), result })).commands).toEqual([]);
  });

  it('reads JSON tool payloads and output envelopes', async () => {
    const result: any = toolResult();
    result.steps[0].toolResults[0].output = JSON.stringify(result.steps[0].toolResults[0].result);
    delete result.steps[0].toolResults[0].result;
    expect((await prepareSingleTurnGateEvidence({ ...base(), result })).commands).toEqual([command()]);
  });
});