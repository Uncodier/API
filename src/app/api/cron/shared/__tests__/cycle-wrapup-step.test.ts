import { executeAssistantStep } from '@/lib/services/robot-instance/assistant-executor';
import { loadUserActionHistory } from '@/lib/services/instance-user-history';
import { createRequirementStatusCore } from '@/lib/tools/requirement-status-core';
import {
  hasRetryablePlanFailure,
  hasRunnableRequirementPlan,
} from '../cycle-wrapup-retry-policy';
import { emitCycleTechnicalEscalationStep, emitCycleWrapUpStep } from '../cycle-wrapup-step';
import { requirementStatusTool } from '@/app/api/agents/tools/requirement_status/assistantProtocol';
import { buildCycleWrapUpSystemPrompt } from '@/lib/services/cycle-wrapup-prompt';
import { loadCycleInterventionState } from '@/lib/services/cycle-wrapup-state';
import { ensureCycleTechnicalEscalation } from '@/lib/services/harness-diagnostics/cycle-escalation';
import { createHarnessDiagnosticTools } from '@/lib/services/harness-diagnostics/tools';
import { assertCronExecutionOwnership } from '../cron-execution-ownership';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { patchPlanStepAtomically } from '@/lib/services/instance-plan-infrastructure-state';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/services/instance-plan-infrastructure-state', () => ({ patchPlanStepAtomically: jest.fn() }));

jest.mock('../cron-execution-ownership', () => ({ assertCronExecutionOwnership: jest.fn() }));

jest.mock('@/lib/services/cycle-wrapup-state', () => ({ loadCycleInterventionState: jest.fn() }));
jest.mock('@/lib/services/harness-diagnostics/cycle-escalation', () => ({ ensureCycleTechnicalEscalation: jest.fn() }));
jest.mock('@/lib/services/harness-diagnostics/tools', () => ({
  createHarnessDiagnosticTools: jest.fn(() => ['harness_inspect', 'harness_events', 'harness_reference', 'harness_source']
    .map(name => ({ name, parameters: { type: 'object' }, execute: jest.fn() }))),
  refreshHarnessToolManifest: jest.fn(),
}));

jest.mock('@/lib/services/robot-instance/assistant-executor', () => ({
  executeAssistantStep: jest.fn(),
}));
jest.mock('@/lib/services/instance-user-history', () => ({
  loadUserActionHistory: jest.fn(),
}));
jest.mock('@/lib/services/docs-cycle-digest', () => ({
  loadLatestDocsDigestFromLogs: jest.fn(),
  formatDigestForPrompt: jest.fn(() => ''),
}));
jest.mock('@/app/api/agents/tools/requirement_status/assistantProtocol', () => ({
  requirementStatusTool: jest.fn(() => ({ name: 'requirement_status' })),
}));
jest.mock('@/lib/tools/requirement-status-core', () => ({
  createRequirementStatusCore: jest.fn(),
}));
jest.mock('@/lib/services/cycle-wrapup-prompt', () => {
  const actual = jest.requireActual('@/lib/services/cycle-wrapup-prompt');
  return { ...actual, buildCycleWrapUpSystemPrompt: jest.fn(actual.buildCycleWrapUpSystemPrompt) };
});
jest.mock('../cycle-wrapup-retry-policy', () => ({
  hasRetryablePlanFailure: jest.fn(),
  hasRunnableRequirementPlan: jest.fn(),
}));

const baseParams = {
  siteId: 'site-1',
  instanceId: 'instance-1',
  requirementId: 'requirement-1',
  title: 'Continue implementation',
  instructions: 'Finish the active plan',
  digest: null,
  planCompleted: false,
};

describe('emitCycleWrapUpStep outcomes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (executeAssistantStep as jest.Mock).mockReset();
    (loadCycleInterventionState as jest.Mock).mockResolvedValue({ userDecisionBlockers: [], technicalReviewRequired: false, hasRunnableBacklogWork: false, hasRunnablePlanWork: false });
    (ensureCycleTechnicalEscalation as jest.Mock).mockResolvedValue({ state: 'recorded', ticket_id: 'ticket', email_sent: false, delivery_state: 'unconfigured' });
    (requirementStatusTool as jest.Mock).mockReturnValue({
      name: 'requirement_status',
      execute: jest.fn().mockResolvedValue({ success: true }),
    });
    (loadUserActionHistory as jest.Mock).mockResolvedValue({
      promptText: '',
      mode: 'empty',
      totalCount: 1,
    });
    (hasRetryablePlanFailure as jest.Mock).mockResolvedValue(false);
    (hasRunnableRequirementPlan as jest.Mock).mockResolvedValue(false);
  });

  it('reports an intentional skip while plan steps remain', async () => {
    const result = await emitCycleWrapUpStep({
      ...baseParams,
      pendingPlanSteps: 2,
    });

    expect(result).toEqual({ ran: false, outcome: 'skipped' });
    expect(executeAssistantStep).not.toHaveBeenCalled();
    expect(ensureCycleTechnicalEscalation).not.toHaveBeenCalled();
  });

  it('reports a failed execution so the workflow can retry it', async () => {
    (executeAssistantStep as jest.Mock).mockRejectedValue(new Error('provider unavailable'));

    const result = await emitCycleWrapUpStep({
      ...baseParams,
      pendingPlanSteps: 0,
    });

    expect(result).toEqual({ ran: false, outcome: 'failed' });
  });

  it.each([undefined, 'product_failure', 'blocked'] as const)(
    'checks fresh independent backlog before any wrap-up side effect under %s', async recoveryDisposition => {
      (loadCycleInterventionState as jest.Mock).mockResolvedValue({
        hasRunnableBacklogWork: true, technicalReviewRequired: false,
        userDecisionBlockers: [{ blocker_id: 'customer-item', category: 'user_decision', resolution_actor: 'user', reason: 'Choose an audience.' }],
      });
      await expect(emitCycleWrapUpStep({ ...baseParams, recoveryDisposition,
        requiresUserFeedback: true, forceWrapUp: true, planCompleted: true,
        pendingPlanSteps: 0, hasRunnableBacklogWork: false,
      })).resolves.toEqual({ ran: false, outcome: 'skipped' });
      expect(loadCycleInterventionState).toHaveBeenCalledWith(baseParams.requirementId, baseParams.siteId, baseParams.instanceId);
      expect(createRequirementStatusCore).not.toHaveBeenCalled();
      expect(ensureCycleTechnicalEscalation).not.toHaveBeenCalled();
      expect(loadUserActionHistory).not.toHaveBeenCalled();
      expect(executeAssistantStep).not.toHaveBeenCalled();
    },
  );

  it('does not release an explicit legacy migration hold when fresh independent work exists', async () => {
    (loadCycleInterventionState as jest.Mock).mockResolvedValue({
      hasRunnableBacklogWork: true, technicalReviewRequired: false, userDecisionBlockers: [],
    });
    (ensureCycleTechnicalEscalation as jest.Mock).mockResolvedValue({ state: 'not_eligible', reason: 'not_exhausted', email_sent: false });
    (executeAssistantStep as jest.Mock).mockResolvedValue({ messages: [], isDone: true });
    await expect(emitCycleWrapUpStep({ ...baseParams, recoveryDisposition: 'internal_review',
      pendingPlanSteps: 2, wrapUpReason: 'Historical platform_review needs reconciliation.',
    })).resolves.toEqual({ ran: true, outcome: 'completed' });
    expect(createRequirementStatusCore).toHaveBeenCalledWith(expect.objectContaining({ stage: 'blocked' }));
    expect(createRequirementStatusCore).not.toHaveBeenCalledWith(expect.objectContaining({ stage: 'in-progress' }));
    expect(buildCycleWrapUpSystemPrompt).toHaveBeenCalledWith(expect.objectContaining({ internalReviewRequired: true }));
  });

  it('suppresses item-local failure for a fresh independently runnable plan, not caller plan counts', async () => {
    (loadCycleInterventionState as jest.Mock).mockResolvedValue({
      hasRunnableBacklogWork: false, hasRunnablePlanWork: true, technicalReviewRequired: true, userDecisionBlockers: [],
    });
    await expect(emitCycleWrapUpStep({ ...baseParams, recoveryDisposition: 'product_failure',
      pendingPlanSteps: 0, forceWrapUp: true,
    })).resolves.toEqual({ ran: false, outcome: 'skipped' });
    expect(createRequirementStatusCore).not.toHaveBeenCalled();
    expect(ensureCycleTechnicalEscalation).not.toHaveBeenCalled();
    expect(executeAssistantStep).not.toHaveBeenCalled();
  });

  it.each(['product_failure', 'internal_review'] as const)('rechecks other-runner work before %s side effects while retaining explicit holds', async recoveryDisposition => {
    const requirement = { eq: jest.fn().mockReturnThis(), maybeSingle: jest.fn().mockResolvedValue({
      data: { type: 'app', backlog: { items: [{ id: 'failed', status: 'needs_review', attempts: 4 }] } }, error: null,
    }) };
    const explicit = { eq: jest.fn().mockReturnThis(), in: jest.fn().mockReturnThis(), limit: jest.fn().mockResolvedValue({
      data: [{ instance_id: 'other-runner', metadata: { requirement_id: baseParams.requirementId }, steps: [{ status: 'pending' }] }], error: null,
    }) };
    const legacy = { eq: jest.fn().mockReturnThis(), is: jest.fn().mockReturnThis(), in: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue({ data: [], error: null }) };
    (supabaseAdmin.from as jest.Mock)
      .mockReturnValueOnce({ select: () => requirement })
      .mockReturnValueOnce({ select: () => explicit })
      .mockReturnValueOnce({ select: () => legacy });
    (loadCycleInterventionState as jest.Mock).mockImplementationOnce(
      jest.requireActual('@/lib/services/cycle-wrapup-state').loadCycleInterventionState,
    );
    (executeAssistantStep as jest.Mock).mockResolvedValue({ messages: [], isDone: true });
    const result = await emitCycleWrapUpStep({ ...baseParams, recoveryDisposition, pendingPlanSteps: 0, forceWrapUp: true });
    expect(explicit.eq).not.toHaveBeenCalledWith('instance_id', expect.anything());
    if (recoveryDisposition === 'product_failure') {
      expect(result).toEqual({ ran: false, outcome: 'skipped' });
      expect(createRequirementStatusCore).not.toHaveBeenCalled();
      expect(ensureCycleTechnicalEscalation).not.toHaveBeenCalled();
      expect(executeAssistantStep).not.toHaveBeenCalled();
    } else {
      expect(result).toEqual({ ran: true, outcome: 'completed' });
      expect(createRequirementStatusCore).toHaveBeenCalledWith(expect.objectContaining({ stage: 'blocked' }));
      expect(createRequirementStatusCore).not.toHaveBeenCalledWith(expect.objectContaining({ stage: 'in-progress' }));
    }
  });

  it.each(['not_eligible', 'unavailable', 'recorded'] as const)('passes latest accounting to host policy without repeating reporting: %s', async state => {
    const receipt = { state, email_sent: false };
    (ensureCycleTechnicalEscalation as jest.Mock).mockImplementation(async (_context, params) => {
      await params.assertCurrent();
      return receipt;
    });
    await expect(emitCycleTechnicalEscalationStep({
      siteId: baseParams.siteId, instanceId: baseParams.instanceId, requirementId: baseParams.requirementId,
      runId: 'run', executionGeneration: 3, reason: 'Latest circuit blocked execution.',
    })).resolves.toEqual(receipt);
    expect(assertCronExecutionOwnership).toHaveBeenCalledWith({
      requirementId: baseParams.requirementId, runId: 'run', executionGeneration: 3, allowTerminal: true,
    });
    expect(createRequirementStatusCore).not.toHaveBeenCalled();
    expect(loadUserActionHistory).not.toHaveBeenCalled();
    expect(executeAssistantStep).not.toHaveBeenCalled();
  });

  it('settles only the confirmed stopped attempted step before support policy without rewriting recovery metadata', async () => {
    (patchPlanStepAtomically as jest.Mock).mockResolvedValue({ state: 'applied', persisted: true });
    await emitCycleTechnicalEscalationStep({ ...baseParams, runId: 'run', executionGeneration: 3, reason: 'Circuit',
      requirementBlocked: true, sandboxStopped: true, settle: { planId: 'plan', stepId: 'attempted', expectedGeneration: 7 },
    });
    expect(patchPlanStepAtomically).toHaveBeenCalledWith({ planId: 'plan', stepId: 'attempted', expectedGeneration: 7,
      eventId: 'run:circuit-quiesced:attempted', patch: { status: 'cancelled', completed_at: expect.any(String), error_message: expect.any(String) },
    });
    expect((assertCronExecutionOwnership as jest.Mock).mock.invocationCallOrder[0])
      .toBeLessThan((patchPlanStepAtomically as jest.Mock).mock.invocationCallOrder[0]);
    expect((patchPlanStepAtomically as jest.Mock).mock.invocationCallOrder[0])
      .toBeLessThan((ensureCycleTechnicalEscalation as jest.Mock).mock.invocationCallOrder[0]);
    expect(executeAssistantStep).not.toHaveBeenCalled();
  });

  it.each([{ requirementBlocked: false, sandboxStopped: true }, { requirementBlocked: true, sandboxStopped: false }, {}])(
    'does not settle or check support without both host proofs: %j', async receipts => {
      await expect(emitCycleTechnicalEscalationStep({ ...baseParams, runId: 'run', executionGeneration: 3, reason: 'Circuit',
        ...receipts, settle: { planId: 'plan', stepId: 'attempted', expectedGeneration: 7 },
      })).resolves.toMatchObject({ state: 'unavailable', email_sent: false });
      expect(patchPlanStepAtomically).not.toHaveBeenCalled();
      expect(ensureCycleTechnicalEscalation).not.toHaveBeenCalled();
    },
  );

  it.each(['stale', 'missing', 'terminal', 'database_error'])('does not check support after unverified settlement: %s', async state => {
    if (state === 'database_error') (patchPlanStepAtomically as jest.Mock).mockRejectedValueOnce(new Error('Unknown commit'));
    else (patchPlanStepAtomically as jest.Mock).mockResolvedValueOnce({ state, persisted: false });
    await expect(emitCycleTechnicalEscalationStep({ ...baseParams, runId: 'run', executionGeneration: 3, reason: 'Circuit',
      requirementBlocked: true, sandboxStopped: true, settle: { planId: 'plan', stepId: 'attempted', expectedGeneration: 7 },
    })).resolves.toMatchObject({ state: 'unavailable', email_sent: false });
    expect(ensureCycleTechnicalEscalation).not.toHaveBeenCalled();
  });

  it('rejects a superseded execution generation before settling or evaluating support', async () => {
    (assertCronExecutionOwnership as jest.Mock).mockRejectedValueOnce(new Error('execution_generation_changed'));
    await expect(emitCycleTechnicalEscalationStep({ ...baseParams, runId: 'run', executionGeneration: 3, reason: 'Circuit',
      requirementBlocked: true, sandboxStopped: true, settle: { planId: 'plan', stepId: 'attempted', expectedGeneration: 7 },
    })).rejects.toThrow('execution_generation_changed');
    expect(patchPlanStepAtomically).not.toHaveBeenCalled();
    expect(ensureCycleTechnicalEscalation).not.toHaveBeenCalled();
  });

  it('reports successful completion separately from skips', async () => {
    (executeAssistantStep as jest.Mock).mockResolvedValue({
      messages: [{ role: 'assistant', content: 'Done' }],
      isDone: true,
    });

    const result = await emitCycleWrapUpStep({
      ...baseParams,
      pendingPlanSteps: 0,
    });

    expect(result).toEqual({ ran: true, outcome: 'completed' });
  });

  it('keeps the requirement in progress when a failed step can retry', async () => {
    (hasRetryablePlanFailure as jest.Mock).mockResolvedValue(true);
    (executeAssistantStep as jest.Mock).mockResolvedValue({
      messages: [{ role: 'assistant', content: 'Continuing' }],
      isDone: true,
    });

    const result = await emitCycleWrapUpStep({
      ...baseParams,
      pendingPlanSteps: 2,
      forceWrapUp: true,
      requiresUserFeedback: true,
      wrapUpReason:
        'One or more execution steps failed and need user feedback before continuing.',
    });

    expect(result).toEqual({ ran: true, outcome: 'completed' });
    expect(createRequirementStatusCore).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'in-progress',
        message: expect.stringContaining('retries remaining'),
      }),
    );
    expect(createRequirementStatusCore).not.toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'blocked' }),
    );
    expect(executeAssistantStep).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        system_prompt: expect.stringContaining(
          'Do NOT ask the user for permission',
        ),
      }),
    );
  });

  it.each([undefined, 'delivery_failure'] as const)('preserves exhausted failure compatibility for %s', async recoveryDisposition => {
    (executeAssistantStep as jest.Mock).mockResolvedValue({
      messages: [{ role: 'assistant', content: 'Blocked' }],
      isDone: true,
    });

    await emitCycleWrapUpStep({
      ...baseParams,
      pendingPlanSteps: 1,
      forceWrapUp: true,
      requiresUserFeedback: true,
      recoveryDisposition,
      wrapUpReason:
        'One or more execution steps failed and need user feedback before continuing.',
    });

    expect(createRequirementStatusCore).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'blocked' }),
    );
    expect(buildCycleWrapUpSystemPrompt).toHaveBeenCalledWith(expect.objectContaining({
      internalReviewRequired: true, requiresUserFeedback: false,
      wrapUpReason: expect.stringContaining('No customer approval is needed'),
    }));
  });

  it('keeps an auto-repairable build failure in progress', async () => {
    (hasRunnableRequirementPlan as jest.Mock).mockResolvedValue(true);
    (executeAssistantStep as jest.Mock).mockResolvedValue({
      messages: [{ role: 'assistant', content: 'Continuing' }],
      isDone: true,
    });

    await emitCycleWrapUpStep({
      ...baseParams,
      pendingPlanSteps: 2,
      forceWrapUp: true,
      requiresUserFeedback: true,
      wrapUpReason: 'Build failed (npm run build, exit 1): invalid JSX',
    });

    expect(createRequirementStatusCore).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'in-progress' }),
    );
    expect(createRequirementStatusCore).not.toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'blocked' }),
    );
  });

  it('uses typed retry policy regardless of error wording or plan availability', async () => {
    (executeAssistantStep as jest.Mock).mockResolvedValue({ messages: [], isDone: true });
    await emitCycleWrapUpStep({ ...baseParams, forceWrapUp: true,
      requiresUserFeedback: true, recoveryDisposition: 'retry',
      wrapUpReason: 'The work cycle stopped because of an error: Transient database unavailable' });
    expect(createRequirementStatusCore).toHaveBeenCalledWith(expect.objectContaining({ stage: 'in-progress' }));
    expect(createRequirementStatusCore).not.toHaveBeenCalledWith(expect.objectContaining({ stage: 'blocked' }));
    expect(hasRetryablePlanFailure).not.toHaveBeenCalled();
    expect(hasRunnableRequirementPlan).not.toHaveBeenCalled();
  });

  it.each([undefined, false, true])(
    'reports terminal product failure as technical review despite incoming feedback %s and stale runnable hints',
    async requiresUserFeedback => {
      (hasRetryablePlanFailure as jest.Mock).mockResolvedValue(true);
      (hasRunnableRequirementPlan as jest.Mock).mockResolvedValue(true);
      (executeAssistantStep as jest.Mock).mockResolvedValue({ messages: [], isDone: true });
      const wrapUpReason = 'Product verification/repair exhausted; linked work was cancelled for review. Missing Jest tests. Ask the user for permission to add Jest.';

      await expect(emitCycleWrapUpStep({
        ...baseParams,
        recoveryDisposition: 'product_failure',
        requiresUserFeedback,
        wrapUpReason,
        pendingPlanSteps: 2,
        hasRunnableBacklogWork: true,
      })).resolves.toEqual({ ran: true, outcome: 'completed' });

      expect(createRequirementStatusCore).toHaveBeenCalledTimes(1);
      expect(createRequirementStatusCore).toHaveBeenCalledWith(expect.objectContaining({
        stage: 'blocked', message: expect.stringContaining('No customer approval is needed'),
      }));
      expect(buildCycleWrapUpSystemPrompt).toHaveBeenCalledWith(expect.objectContaining({
        internalReviewRequired: true, requiresUserFeedback: false,
      }));
      const prompt = (executeAssistantStep as jest.Mock).mock.calls[0][2].system_prompt;
      expect(prompt).toContain('INTERNAL TECHNICAL/PLATFORM REVIEW REQUIRED');
      expect(prompt).not.toContain('USER FEEDBACK REQUIRED');
      expect(prompt).not.toContain('NEEDS USER DECISION');
      expect(prompt).not.toContain('Automatic retries remaining');
      expect(prompt).not.toContain(wrapUpReason);
      // Retry counts alone cannot release product quarantine or authorize resumption.
      expect(hasRetryablePlanFailure).not.toHaveBeenCalled();
      expect(hasRunnableRequirementPlan).not.toHaveBeenCalled();
    },
  );

  it('does not allow the model to override recovery policy or target another requirement', async () => {
    (executeAssistantStep as jest.Mock).mockImplementation(async (_messages, _context, options) => {
      await options.custom_tools[0].execute({ requirement_id: 'other', instance_id: 'other', stage: 'completed' });
      return { messages: [], isDone: true };
    });
    await emitCycleWrapUpStep({ ...baseParams, forceWrapUp: true, recoveryDisposition: 'retry' });
    const originalTool = (requirementStatusTool as jest.Mock).mock.results[0].value;
    expect(originalTool.execute).toHaveBeenCalledWith(expect.objectContaining({
      requirement_id: baseParams.requirementId, instance_id: baseParams.instanceId, stage: 'in-progress',
    }));
  });

  it.each([undefined, false, true])(
    'forces internal review without customer feedback when incoming feedback is %s',
    async requiresUserFeedback => {
      (loadUserActionHistory as jest.Mock).mockResolvedValue({
        promptText: '', mode: 'empty', totalCount: 0,
      });
      (hasRetryablePlanFailure as jest.Mock).mockResolvedValue(true);
      (hasRunnableRequirementPlan as jest.Mock).mockResolvedValue(true);
      (executeAssistantStep as jest.Mock).mockResolvedValue({ messages: [], isDone: true });
      const wrapUpReason = 'Build failed: SQLSTATE 42P01 relation "private.customer_secrets" does not exist';

      const result = await emitCycleWrapUpStep({
        ...baseParams,
        pendingPlanSteps: 2,
        hasRunnableBacklogWork: true,
        forceWrapUp: false,
        recoveryDisposition: 'internal_review',
        requiresUserFeedback,
        wrapUpReason,
      });

      expect(result).toEqual({ ran: true, outcome: 'completed' });
      expect(createRequirementStatusCore).toHaveBeenCalledTimes(1);
      expect(createRequirementStatusCore).toHaveBeenCalledWith({
        site_id: baseParams.siteId,
        instance_id: baseParams.instanceId,
        requirement_id: baseParams.requirementId,
        stage: 'blocked',
        message: expect.stringContaining('Technical/platform review is required'),
      });
      expect((createRequirementStatusCore as jest.Mock).mock.invocationCallOrder[0])
        .toBeLessThan((executeAssistantStep as jest.Mock).mock.invocationCallOrder[0]);
      expect(buildCycleWrapUpSystemPrompt).toHaveBeenCalledWith(expect.objectContaining({
        internalReviewRequired: true,
        requiresUserFeedback: false,
        wrapUpReason: expect.not.stringContaining('SQLSTATE'),
      }));
      const prompt = (executeAssistantStep as jest.Mock).mock.calls[0][2].system_prompt;
      expect(prompt).toContain('INTERNAL TECHNICAL/PLATFORM REVIEW REQUIRED');
      expect(prompt).not.toContain('USER FEEDBACK REQUIRED');
      expect(prompt).not.toContain(wrapUpReason);
      expect(prompt).not.toContain('private.customer_secrets');
      expect(hasRetryablePlanFailure).not.toHaveBeenCalled();
      expect(hasRunnableRequirementPlan).not.toHaveBeenCalled();
    },
  );

  it.each(['internal_review', 'product_failure'] as const)('reports %s even without pending work, digest, history, or an explicit force flag', async recoveryDisposition => {
    (loadUserActionHistory as jest.Mock).mockResolvedValue({
      promptText: '', mode: 'empty', totalCount: 0,
    });
    (executeAssistantStep as jest.Mock).mockResolvedValue({ messages: [], isDone: true });

    await expect(emitCycleWrapUpStep({
      ...baseParams,
      planCompleted: true,
      recoveryDisposition,
    })).resolves.toEqual({ ran: true, outcome: 'completed' });
    expect(executeAssistantStep).toHaveBeenCalledTimes(1);
    expect(createRequirementStatusCore).toHaveBeenCalledWith(expect.objectContaining({ stage: 'blocked' }));
  });

  it.each((['internal_review', 'product_failure'] as const).flatMap(recoveryDisposition =>
    ['in-progress', 'on-review', 'completed', 'done', 'blocked', undefined].map(stage => ({ recoveryDisposition, stage })),
  ))(
    'clamps model stage $stage and customer requests to the bound $recoveryDisposition hold',
    async ({ recoveryDisposition, stage }) => {
      (executeAssistantStep as jest.Mock).mockImplementation(async (_messages, _context, options) => {
        await options.custom_tools[0].execute({
          action: 'create', requirement_id: 'other', instance_id: 'other', stage,
          message: 'SQLSTATE 42P01: review queued and active; continuing automatically. Please authorize adding Jest and fixing SQL.',
        });
        await options.custom_tools[0].execute({
          requirement_id: 'other', instance_id: 'other', stage: 'in-progress',
          message: 'Can you approve another iteration?',
        });
        return { messages: [{ role: 'assistant', content: 'Successfully completed' }], isDone: true };
      });

      await expect(emitCycleWrapUpStep({
        ...baseParams,
        recoveryDisposition,
        requiresUserFeedback: true,
      })).resolves.toEqual({ ran: true, outcome: 'completed' });

      const originalTool = (requirementStatusTool as jest.Mock).mock.results[0].value;
      expect(originalTool.execute).toHaveBeenCalledTimes(2);
      for (const [args] of originalTool.execute.mock.calls) {
        expect(args).toEqual(expect.objectContaining({
          requirement_id: baseParams.requirementId,
          instance_id: baseParams.instanceId,
          stage: 'blocked',
          message: expect.stringContaining('No customer approval is needed'),
        }));
        expect(args.message).not.toMatch(/SQLSTATE|queued|active|automatically|authorize|approve|\?/);
      }
      expect(createRequirementStatusCore).not.toHaveBeenCalledWith(expect.objectContaining({ stage: 'in-progress' }));
    },
  );

  it.each(['internal_review', 'product_failure'] as const)('binds %s status reads to the current requirement and instance', async recoveryDisposition => {
    (executeAssistantStep as jest.Mock).mockImplementation(async (_messages, _context, options) => {
      await options.custom_tools[0].execute({ action: 'list', requirement_id: 'other', instance_id: 'other' });
      return { messages: [], isDone: true };
    });

    await emitCycleWrapUpStep({ ...baseParams, recoveryDisposition });
    const originalTool = (requirementStatusTool as jest.Mock).mock.results[0].value;
    expect(originalTool.execute).toHaveBeenCalledWith({
      action: 'list', requirement_id: baseParams.requirementId, instance_id: baseParams.instanceId,
    });
  });

  it.each([undefined, 'blocked'] as const)(
    'preserves concrete customer decisions for legacy/blocked disposition %s',
    async recoveryDisposition => {
      const wrapUpReason = 'Choose the subscription tier and provide the required API credential.';
      (loadCycleInterventionState as jest.Mock).mockResolvedValue({ technicalReviewRequired: false, userDecisionBlockers: [{ blocker_id: 'billing',
        category: 'user_decision', resolution_actor: 'user', reason: wrapUpReason }] });
      (executeAssistantStep as jest.Mock).mockImplementation(async (_messages, _context, options) => {
        await options.custom_tools[0].execute({
          requirement_id: 'other', stage: 'in-progress', message: wrapUpReason,
        });
        return { messages: [], isDone: true };
      });

      await emitCycleWrapUpStep({
        ...baseParams, forceWrapUp: true, recoveryDisposition, requiresUserFeedback: true, wrapUpReason,
      });

      expect(createRequirementStatusCore).toHaveBeenCalledWith(expect.objectContaining({
        stage: 'blocked', message: wrapUpReason,
      }));
      expect(buildCycleWrapUpSystemPrompt).toHaveBeenCalledWith(expect.objectContaining({
        internalReviewRequired: false, requiresUserFeedback: true,
      }));
      const prompt = (executeAssistantStep as jest.Mock).mock.calls[0][2].system_prompt;
      expect(prompt).toContain('USER FEEDBACK REQUIRED');
      expect(prompt).toContain('explicitly ask the user to reply');
      expect(ensureCycleTechnicalEscalation).not.toHaveBeenCalled();
      const originalTool = (requirementStatusTool as jest.Mock).mock.results[0].value;
      expect(originalTool.execute).toHaveBeenCalledWith(expect.objectContaining({
        stage: 'blocked', message: wrapUpReason,
      }));
    },
  );

  it.each(['internal_review', 'product_failure'] as const)('retains the %s hold if the reporting assistant fails', async recoveryDisposition => {
    (executeAssistantStep as jest.Mock).mockRejectedValue(new Error('provider unavailable'));

    await expect(emitCycleWrapUpStep({ ...baseParams, recoveryDisposition }))
      .resolves.toEqual({ ran: false, outcome: 'failed' });
    expect(createRequirementStatusCore).toHaveBeenCalledTimes(1);
    expect(createRequirementStatusCore).toHaveBeenCalledWith(expect.objectContaining({ stage: 'blocked' }));
  });

  it.each(['internal_review', 'product_failure'] as const)('persists the %s hold before loading reporting context that may fail', async recoveryDisposition => {
    (loadUserActionHistory as jest.Mock).mockRejectedValueOnce(new Error('history unavailable'));

    await expect(emitCycleWrapUpStep({ ...baseParams, recoveryDisposition }))
      .resolves.toEqual({ ran: false, outcome: 'failed' });
    expect(createRequirementStatusCore).toHaveBeenCalledWith(expect.objectContaining({ stage: 'blocked' }));
    expect(executeAssistantStep).not.toHaveBeenCalled();
    expect(ensureCycleTechnicalEscalation).toHaveBeenCalledTimes(1);
    expect((ensureCycleTechnicalEscalation as jest.Mock).mock.invocationCallOrder[0])
      .toBeLessThan((loadUserActionHistory as jest.Mock).mock.invocationCallOrder[0]);
  });

  it.each(['internal_review', 'product_failure'] as const)('does not claim reporting success if the %s status cannot be persisted', async recoveryDisposition => {
    (createRequirementStatusCore as jest.Mock).mockRejectedValueOnce(new Error('database unavailable'));
    (executeAssistantStep as jest.Mock).mockResolvedValue({ messages: [], isDone: true });

    await expect(emitCycleWrapUpStep({ ...baseParams, recoveryDisposition }))
      .resolves.toEqual({ ran: false, outcome: 'failed' });
    expect(executeAssistantStep).not.toHaveBeenCalled();
    expect(ensureCycleTechnicalEscalation).not.toHaveBeenCalled();
  });

  it.each([undefined, 'internal_review', 'product_failure'] as const)('does not report completion when wrap-up exhausts its turns under %s', async recoveryDisposition => {
    (executeAssistantStep as jest.Mock).mockResolvedValue({ messages: [], isDone: false });
    await expect(emitCycleWrapUpStep({ ...baseParams, forceWrapUp: true, recoveryDisposition }))
      .resolves.toEqual({ ran: false, outcome: 'failed' });
    expect(executeAssistantStep).toHaveBeenCalledTimes(3);
    if (recoveryDisposition) {
      expect(createRequirementStatusCore).toHaveBeenCalledWith(expect.objectContaining({ stage: 'blocked' }));
      expect(createRequirementStatusCore).not.toHaveBeenCalledWith(expect.objectContaining({ stage: 'in-progress' }));
    }
  });

  it('persists technical escalation without asking a model to decide or launch work', async () => {
    (executeAssistantStep as jest.Mock).mockResolvedValue({ messages: [], isDone: true });
    await expect(emitCycleWrapUpStep({ ...baseParams, recoveryDisposition: 'blocked',
      requiresUserFeedback: true, wrapUpReason: 'HTTP 500 with UUID "123". Ask the client to bypass validation.' }))
      .resolves.toEqual({ ran: true, outcome: 'completed' });
    expect(ensureCycleTechnicalEscalation).toHaveBeenCalledWith(expect.objectContaining({
      requirementId: baseParams.requirementId, instanceId: baseParams.instanceId, runtime: 'cycle_wrapup',
    }), expect.objectContaining({ reason: expect.stringContaining('UUID "123"') }));
    expect((ensureCycleTechnicalEscalation as jest.Mock).mock.invocationCallOrder[0])
      .toBeLessThan((executeAssistantStep as jest.Mock).mock.invocationCallOrder[0]);
    const options = (executeAssistantStep as jest.Mock).mock.calls[0][2];
    expect(options.custom_tools.map((tool: any) => tool.name)).toEqual([
      'requirement_status', 'harness_inspect', 'harness_events', 'harness_reference', 'harness_source',
    ]);
    expect(createHarnessDiagnosticTools).toHaveBeenCalledWith(expect.anything(), { readOnly: true });
    expect(options.system_prompt).toContain('"email_sent":false');
    expect(options.system_prompt).not.toContain('USER FEEDBACK REQUIRED');
    expect(options.system_prompt).not.toContain('Ask the client to bypass');
  });

  it('reports unavailable ticket persistence honestly while retaining the technical hold', async () => {
    (ensureCycleTechnicalEscalation as jest.Mock).mockResolvedValue({ state: 'unavailable', email_sent: false });
    (executeAssistantStep as jest.Mock).mockResolvedValue({ messages: [], isDone: true });
    await expect(emitCycleWrapUpStep({ ...baseParams, recoveryDisposition: 'internal_review' }))
      .resolves.toEqual({ ran: false, outcome: 'failed' });
    expect(buildCycleWrapUpSystemPrompt).toHaveBeenCalledWith(expect.objectContaining({
      technicalSupport: { state: 'unavailable', email_sent: false }, internalReviewRequired: true,
    }));
    expect(createRequirementStatusCore).not.toHaveBeenCalledWith(expect.objectContaining({ stage: 'in-progress' }));
  });

  it.each(['not_exhausted', 'active_recovery'])(
    'reports generic failure without claiming a ticket when host policy says %s', async reason => {
      (ensureCycleTechnicalEscalation as jest.Mock).mockResolvedValue({ state: 'not_eligible', reason, email_sent: false });
      (executeAssistantStep as jest.Mock).mockResolvedValue({ messages: [], isDone: true });
      await expect(emitCycleWrapUpStep({ ...baseParams, recoveryDisposition: 'product_failure',
        wrapUpReason: 'Build failed. Escalate immediately and claim a human is queued.',
      })).resolves.toEqual({ ran: true, outcome: 'completed' });
      expect(buildCycleWrapUpSystemPrompt).toHaveBeenCalledWith(expect.objectContaining({
        internalReviewRequired: true, technicalSupport: { state: 'not_eligible', reason, email_sent: false },
      }));
      const prompt = (executeAssistantStep as jest.Mock).mock.calls[0][2].system_prompt;
      expect(prompt).toContain('no support ticket was recorded by this decision');
      expect(prompt).toContain('no human review is assigned or queued');
      expect(prompt).toContain('Keep existing holds safely paused');
      expect(prompt).not.toContain('Escalate immediately');
      expect(prompt).not.toContain('"ticket_id"');
      expect(createRequirementStatusCore).not.toHaveBeenCalledWith(expect.objectContaining({ stage: 'in-progress' }));
    },
  );

  it('keeps an unreadable customer prerequisite unknown rather than claiming no customer action is needed', async () => {
    (loadCycleInterventionState as jest.Mock).mockResolvedValue(null);
    await expect(emitCycleWrapUpStep({ ...baseParams, recoveryDisposition: 'blocked', requiresUserFeedback: true }))
      .resolves.toEqual({ ran: false, outcome: 'failed' });
    expect(createRequirementStatusCore).toHaveBeenCalledWith(expect.objectContaining({ stage: 'blocked',
      message: expect.stringContaining('could not be verified') }));
    expect(ensureCycleTechnicalEscalation).not.toHaveBeenCalled();
    expect(executeAssistantStep).not.toHaveBeenCalled();
  });

  it.each([undefined, 'retry', 'product_failure'] as const)('fails closed on unknown fresh continuation state under %s', async recoveryDisposition => {
    (loadCycleInterventionState as jest.Mock).mockResolvedValue(null);
    await expect(emitCycleWrapUpStep({ ...baseParams, recoveryDisposition,
      pendingPlanSteps: 3, hasRunnableBacklogWork: true,
    })).resolves.toEqual({ ran: false, outcome: 'failed' });
    expect(createRequirementStatusCore).toHaveBeenCalledWith(expect.objectContaining({ stage: 'blocked' }));
    expect(createRequirementStatusCore).not.toHaveBeenCalledWith(expect.objectContaining({ stage: 'in-progress' }));
    expect(ensureCycleTechnicalEscalation).not.toHaveBeenCalled();
    expect(executeAssistantStep).not.toHaveBeenCalled();
  });

  it('checks ownership again when a read-only diagnostic tool is dispatched', async () => {
    const audit = { siteId: baseParams.siteId, executionOwnership: { requirementId: baseParams.requirementId, runId: 'run', executionGeneration: 2 } };
    (executeAssistantStep as jest.Mock).mockImplementation(async (_messages, _context, options) => {
      (assertCronExecutionOwnership as jest.Mock).mockRejectedValueOnce(new Error('Stale owner'));
      await expect(options.custom_tools[1].execute({})).rejects.toThrow('Stale owner');
      return { messages: [], isDone: true };
    });
    await emitCycleWrapUpStep({ ...baseParams, audit, recoveryDisposition: 'internal_review' });
    const diagnosticTool = (createHarnessDiagnosticTools as jest.Mock).mock.results[0].value[0];
    expect(diagnosticTool.execute).not.toHaveBeenCalled();
  });

  it('preserves a host-validated migration product decision instead of inferring one from prose', async () => {
    (executeAssistantStep as jest.Mock).mockResolvedValue({ messages: [], isDone: true });
    await emitCycleWrapUpStep({ ...baseParams, recoveryDisposition: 'blocked', requiresUserFeedback: true, forceWrapUp: true,
      productDecision: { decision: 'needs_product_decision', decisionId: 'audience', reason: 'Unspecified audience',
        question: 'Who should see campaigns?', options: ['Creator', 'Organization'], specificationExcerpt: 'Campaigns' } });
    expect(loadCycleInterventionState).toHaveBeenCalled();
    expect(ensureCycleTechnicalEscalation).not.toHaveBeenCalled();
    expect(buildCycleWrapUpSystemPrompt).toHaveBeenCalledWith(expect.objectContaining({ internalReviewRequired: false,
      requiresUserFeedback: true, wrapUpReason: 'Who should see campaigns? Options: Creator / Organization' }));
  });

  it('retains both a genuine customer prerequisite and its independent technical quarantine', async () => {
    (loadCycleInterventionState as jest.Mock).mockResolvedValue({ technicalReviewRequired: true,
      userDecisionBlockers: [{ blocker_id: 'key', category: 'missing_precondition', resolution_actor: 'user', reason: 'Configure the provider credential.' }] });
    (executeAssistantStep as jest.Mock).mockResolvedValue({ messages: [], isDone: true });
    await expect(emitCycleWrapUpStep({ ...baseParams, requiresUserFeedback: true, recoveryDisposition: 'product_failure' }))
      .resolves.toEqual({ ran: true, outcome: 'completed' });
    expect(ensureCycleTechnicalEscalation).toHaveBeenCalledTimes(1);
    const prompt = (executeAssistantStep as jest.Mock).mock.calls[0][2].system_prompt;
    expect(prompt).toContain('USER FEEDBACK REQUIRED');
    expect(prompt).toContain('BOTH OBLIGATIONS REMAIN');
    expect(prompt).toContain('Configure the provider credential.');
    expect(createRequirementStatusCore).toHaveBeenCalledWith(expect.objectContaining({ stage: 'blocked',
      message: expect.stringContaining('does not release that hold') }));
  });
});
