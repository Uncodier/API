jest.mock('../step-git-gate', () => ({ verifyOriginAndRecover: jest.fn() }));
jest.mock('@/lib/services/requirement-constraints-persist', () => ({ loadConstraintSourceBlocks: jest.fn(async () => []) }));
jest.mock('@/lib/services/requirement-backlog', () => ({ getBacklogItem: jest.fn() }));
jest.mock('@/lib/services/requirement-ground-truth', () => ({ writeEvidence: jest.fn() }));
import { runTaskGate } from '../gates/gate-task';
import { verifyOriginAndRecover } from '../step-git-gate';
import { persistResearchTurn } from '../research-evidence-persistence';
import { getBacklogItem } from '@/lib/services/requirement-backlog';
import { writeEvidence } from '@/lib/services/requirement-ground-truth';

function input() {
  return {
    flow: 'makinari' as const, requirementId: 'req', workDir: '/work',
    sandbox: { runCommand: jest.fn(async () => ({ stdout: async () => '', exitCode: 0 })) } as any,
    item: { id: 'item', title: 'Research', kind: 'doc', acceptance: ['Compare alternatives'],
      constraints: ['Sin código/repositorio/carpetas. Entregar el informe en step_output.'],
      evidence: { research: { requirement_id: 'req', item_id: 'item', plan_id: 'plan', execution_generation: 1,
        sources: [{ tool_call_id: 'search', tool_name: 'webSearch', step_id: 'step', captured_at: '',
          url: 'https://example.invalid/source', title: 'Source', excerpt: 'Source evidence' }],
        reports: [{ tool_call_id: 'report', step_id: 'step', captured_at: '', text: 'Findings https://example.invalid/source', truncated: false }],
      } },
    } as any,
    appContext: {} as any,
  };
}

describe('report-only task gate and canonical evidence', () => {
  beforeEach(() => jest.clearAllMocks());
  it('admits report + observed sources to Judge without filesystem or git recovery', async () => {
    const params = input();
    expect(await runTaskGate(params)).toMatchObject({ ok: true });
    expect(params.sandbox.runCommand).not.toHaveBeenCalled();
    expect(verifyOriginAndRecover).not.toHaveBeenCalled();
  });
  it('fails closed on missing sources without suggesting repo artifacts', async () => {
    const params = input();
    params.item.evidence.research.sources = [];
    expect(await runTaskGate(params)).toMatchObject({ ok: false, failureKind: 'evidence_gap' });
    expect(params.sandbox.runCommand).not.toHaveBeenCalled();
  });
  it('preserves declared constraints over the captured report', async () => {
    const params = input();
    params.item.constraints.push('MUST NOT include outbound tactics');
    params.item.evidence.research.reports[0].text += ' Use cold email outbound sequences.';
    expect(await runTaskGate(params)).toMatchObject({ ok: false });
  });
  it('does not bypass existing artifact requirements for repository task delivery', async () => {
    const params = input();
    params.item.constraints = [];
    expect(await runTaskGate(params)).toMatchObject({ ok: false });
    expect(params.sandbox.runCommand).toHaveBeenCalled();
  });
  it('persists captured tool results canonically without writing repo mirrors, and propagates persistence failures', async () => {
    (getBacklogItem as jest.Mock).mockResolvedValue({ item: input().item });
    const params = { requirementId: 'req', itemId: 'item', planId: 'plan', stepId: 'step', executionGeneration: 1,
      assertOwnership: jest.fn(async () => {}),
      result: { steps: [{ toolCalls: [{ id: 'new-report', toolName: 'instance_plan', args: { action: 'execute_step',
        plan_id: 'plan', step_id: 'step', step_status: 'completed', step_output: 'Updated report https://example.invalid/source' } }],
        toolResults: [{ toolCallId: 'new-report', result: { success: true } }] }] } };
    await persistResearchTurn(params);
    expect(writeEvidence).toHaveBeenCalledWith(expect.objectContaining({ requireCanonicalPersistence: true,
      record: { research: expect.objectContaining({ sources: expect.any(Array), reports: expect.any(Array) }) } }));
    expect((writeEvidence as jest.Mock).mock.calls[0][0]).not.toHaveProperty('sandbox');
    expect(params.assertOwnership).toHaveBeenCalledTimes(1);
    (writeEvidence as jest.Mock).mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(persistResearchTurn(params)).rejects.toThrow('storage unavailable');
    (writeEvidence as jest.Mock).mockClear();
    await expect(persistResearchTurn({ ...params, result: {} })).resolves.toBe(false);
    expect(writeEvidence).not.toHaveBeenCalled();
    await expect(persistResearchTurn({ ...params, assertOwnership: async () => { throw new Error('stale owner'); } })).rejects.toThrow('stale owner');
    expect(writeEvidence).not.toHaveBeenCalled();
  });
});