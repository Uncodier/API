import { scheduleMigrationCorrectionStep, verifyPendingMigrationLifecycleStep } from '../migration-lifecycle-steps';
import { listMigrationLifecycle, transitionMigrationLifecycle } from '@/lib/services/apps-platform/migration-lifecycle';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { patchPlanStepAtomically, appendPlanRepairStepAtomically } from '@/lib/services/instance-plan-infrastructure-state';
import { getAppsAdminClient } from '@/lib/database/apps-supabase';
import { runGateStep } from '../gate-step-executor';
import { obtainMigrationDiagnosis } from '../migration-diagnostic-handoff';
import { assignMigrationDiagnosticFollowup, holdMigrationDiagnostic, loadMigrationDiagnostic } from '@/lib/services/apps-platform/migration-diagnostic-state';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/database/apps-supabase', () => ({ getAppsAdminClient: jest.fn() }));
jest.mock('@/lib/services/apps-platform/migration-lifecycle', () => ({ listMigrationLifecycle: jest.fn(), transitionMigrationLifecycle: jest.fn() }));
jest.mock('@/lib/services/apps-platform/migration-application-guard', () => ({
  migrationDigest: (text: string) => require('node:crypto').createHash('sha256').update(text).digest('hex'),
  loadMigrationApplicationContext: jest.fn(async () => ({ specificationChecksum: 'spec', assertCurrent: jest.fn() })),
}));
jest.mock('@/lib/services/instance-plan-infrastructure-state', () => ({ patchPlanStepAtomically: jest.fn(), appendPlanRepairStepAtomically: jest.fn() }));
jest.mock('../cron-execution-ownership', () => ({ assertCronExecutionOwnership: jest.fn() }));
jest.mock('@/lib/services/apps-platform/tenant-capabilities-service', () => ({ getTenantCapabilities: async () => ({ tenant_id: 'tenant', schema: 'app_aaaaaaaaaaaaaaaaaaaaaaaa' }) }));
jest.mock('@/lib/services/apps-platform/migration-repair-files', () => ({ verifyMigrationRepairFiles: jest.fn() }));
jest.mock('@/lib/services/sandbox-recovery', () => ({ connectOrRecreateRequirementSandbox: async () => ({ sandbox: {}, sandboxId: 'recovered' }) }));
jest.mock('../gate-step-executor', () => ({ runGateStep: jest.fn() }));
jest.mock('../migration-diagnostic-handoff', () => ({ obtainMigrationDiagnosis: jest.fn() }));
jest.mock('@/lib/services/apps-platform/migration-diagnostic-state', () => ({ assignMigrationDiagnosticFollowup: jest.fn(), holdMigrationDiagnostic: jest.fn(), loadMigrationDiagnostic: jest.fn() }));

const row = { requirement_id: 'req', file: 'migrations/0001.sql', state: 'correction_required', checksum: 'a'.repeat(64),
  specification_checksum: 'spec', version: 1, attempts: 0, reason: 'DO must be rewritten statically', original_sql: 'DO $$ BEGIN NULL; END $$;',
  review: { binding: { tenant_id: 'tenant', schema: 'app_aaaaaaaaaaaaaaaaaaaaaaaa', checksum: 'a'.repeat(64), specification_checksum: 'spec' } } };
const ownership = { requirementId: 'req', runId: 'run', executionGeneration: 2 };
const plan = { id: 'plan', metadata: { requirement_id: 'req' }, steps: [{ id: 'step', status: 'in_progress', infrastructure_generation: 0,
  metadata: { backlog_item_id: 'item' } }] };

describe('durable migration correction and verification steps', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (listMigrationLifecycle as jest.Mock).mockResolvedValue([row]);
    (supabaseAdmin.from as jest.Mock).mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: plan }) }) }) });
    (patchPlanStepAtomically as jest.Mock).mockResolvedValue({ persisted: true });
    (appendPlanRepairStepAtomically as jest.Mock).mockResolvedValue({ persisted: true });
    (getAppsAdminClient as jest.Mock).mockReturnValue({ readOnly: true, rpc: jest.fn(async () => ({ data: { found: true, value: { checksum: row.checksum } } })) });
    (runGateStep as jest.Mock).mockResolvedValue({ passed: true, effectiveSandboxId: 'recovered' });
  });

  it('assigns real implementation instructions to the source step without requiring the user', async () => {
    await expect(scheduleMigrationCorrectionStep({ requirementId: 'req', planId: 'plan', executionOwnership: ownership }))
      .resolves.toEqual({ scheduled: true, internalReview: false });
    expect(patchPlanStepAtomically).toHaveBeenCalledWith(expect.objectContaining({
      patch: expect.objectContaining({ status: 'pending', requires_sandbox: true, skill: 'makinari-rol-backend',
        instructions: expect.stringContaining('migrations/0001.sql'), metadata: expect.objectContaining({ backlog_item_id: 'item' }) }),
    }));
    expect(transitionMigrationLifecycle).toHaveBeenCalledWith(expect.objectContaining({ value: expect.objectContaining({ attempts: 1 }) }));
  });

  it('preserves completed steps by appending a bounded repair rather than reopening them', async () => {
    (supabaseAdmin.from as jest.Mock).mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: {
      ...plan, steps: [{ ...plan.steps[0], status: 'completed' }],
    } }) }) }) });
    await scheduleMigrationCorrectionStep({ requirementId: 'req', planId: 'plan', executionOwnership: ownership });
    expect(patchPlanStepAtomically).toHaveBeenCalledWith(expect.objectContaining({
      patch: {}, eventId: expect.stringMatching(/^migration-assignment:v1:/),
    }));
    expect(appendPlanRepairStepAtomically).toHaveBeenCalledWith(expect.objectContaining({ repairStep: expect.objectContaining({
      requires_sandbox: true, metadata: expect.objectContaining({ repair_run: expect.objectContaining({ max_attempts: 5 }) }),
    }) }));
  });

  const assignedPlan = (rows: any[], overrides: any = {}) => ({
    ...plan, steps: [{ ...plan.steps[0], requires_sandbox: true, infrastructure_generation: 1,
      metadata: { backlog_item_id: 'item', migration_correction_run_id: 'previous-run',
        migration_correction_binding: rows.map(item => ({ file: item.file, checksum: item.checksum,
          specification_checksum: item.specification_checksum, version: item.version })) }, ...overrides }],
  });
  const loadPlan = (value: any, receipt: 'present' | 'missing' | 'error' = 'present') =>
    (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
      let eventId = '';
      const query: { select: jest.Mock; eq: jest.Mock; maybeSingle: () => Promise<any> } = {
        select: jest.fn(() => query), eq: jest.fn((key, val) => { if (key === 'event_id') eventId = val; return query; }),
        maybeSingle: async () => table === 'instance_plans' ? { data: value } : {
          data: receipt === 'present' ? { event_id: eventId, event_type: 'step_patch', details: { generation: 1 } } : null,
          error: receipt === 'error' ? { code: 'unavailable' } : null,
        } };
      return query;
    });

  it.each(['pending', 'in_progress'])('reuses an unchanged %s assignment across cycles without exhausting migration attempts', async status => {
    const current = { ...row, version: 6, attempts: 5 };
    (listMigrationLifecycle as jest.Mock).mockResolvedValue([current]);
    loadPlan(assignedPlan([current], { status }));
    for (let cycle = 0; cycle < 8; cycle++) {
      expect(await scheduleMigrationCorrectionStep({ requirementId: 'req', planId: 'plan',
        executionOwnership: { ...ownership, runId: `run-${cycle}` } })).toEqual({ scheduled: true, internalReview: false });
    }
    expect(transitionMigrationLifecycle).not.toHaveBeenCalled();
    expect(patchPlanStepAtomically).not.toHaveBeenCalled();
    expect(obtainMigrationDiagnosis).not.toHaveBeenCalled();
  });

  it('uses the pending assigned step rather than overwriting a later unrelated step', async () => {
    const assigned = assignedPlan([row], { status: 'pending' });
    assigned.steps.push({ id: 'later', status: 'completed' } as any);
    loadPlan(assigned);
    await scheduleMigrationCorrectionStep({ requirementId: 'req', planId: 'plan', executionOwnership: ownership });
    expect(appendPlanRepairStepAtomically).not.toHaveBeenCalled();
    expect(transitionMigrationLifecycle).not.toHaveBeenCalled();
  });

  it('does not reassign a batch when database row order changes', async () => {
    const second = { ...row, file: 'migrations/0002.sql' };
    (listMigrationLifecycle as jest.Mock).mockResolvedValue([second, row]);
    loadPlan(assignedPlan([row, second]));
    await scheduleMigrationCorrectionStep({ requirementId: 'req', planId: 'plan', executionOwnership: ownership });
    expect(transitionMigrationLifecycle).not.toHaveBeenCalled();
  });

  it('compares persisted jsonb bindings by fields, not object key order', async () => {
    const assigned = assignedPlan([row]);
    assigned.steps[0].metadata.migration_correction_binding = [{ version: row.version,
      checksum: row.checksum, file: row.file, specification_checksum: row.specification_checksum }];
    loadPlan(assigned);
    await scheduleMigrationCorrectionStep({ requirementId: 'req', planId: 'plan', executionOwnership: ownership });
    expect(transitionMigrationLifecycle).not.toHaveBeenCalled();
  });

  it.each(['pending', 'in_progress'])('preserves legacy %s assignment reuse within the same run', async status => {
    loadPlan({ ...plan, steps: [{ ...plan.steps[0], status, requires_sandbox: true, metadata: {
      migration_correction_key: `${row.file}:${row.checksum}`, migration_correction_run_id: ownership.runId,
    } }] });
    await scheduleMigrationCorrectionStep({ requirementId: 'req', planId: 'plan', executionOwnership: ownership });
    expect(transitionMigrationLifecycle).not.toHaveBeenCalled();
  });

  it('does not use another requirement owner to mutate a correction plan', async () => {
    await expect(scheduleMigrationCorrectionStep({ requirementId: 'other', planId: 'plan', executionOwnership: ownership }))
      .rejects.toThrow('ownership does not match');
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
  });

  it('does not treat model-authored binding as proof of assignment at the exhausted budget', async () => {
    const exhausted = { ...row, attempts: 5 };
    (listMigrationLifecycle as jest.Mock).mockResolvedValue([exhausted]);
    loadPlan(assignedPlan([exhausted]), 'missing');
    expect(await scheduleMigrationCorrectionStep({ requirementId: 'req', planId: 'plan', executionOwnership: ownership }))
      .toEqual({ scheduled: false, internalReview: false, diagnosticPending: true });
    expect(transitionMigrationLifecycle).not.toHaveBeenCalled();
    expect(patchPlanStepAtomically).not.toHaveBeenCalled();
  });

  it('fails closed when assignment evidence cannot be read', async () => {
    loadPlan(assignedPlan([row]), 'error');
    await expect(scheduleMigrationCorrectionStep({ requirementId: 'req', planId: 'plan', executionOwnership: ownership }))
      .rejects.toThrow('assignment receipt is unavailable');
    expect(transitionMigrationLifecycle).not.toHaveBeenCalled();
  });

  it.each([{ version: 2 }, { checksum: 'b'.repeat(64) }, { specification_checksum: 'new-spec' }])(
    'does not reuse stale correction evidence: %j', async change => {
      loadPlan(assignedPlan([row]));
      (listMigrationLifecycle as jest.Mock).mockResolvedValue([{ ...row, ...change }]);
      await scheduleMigrationCorrectionStep({ requirementId: 'req', planId: 'plan', executionOwnership: ownership });
      expect(transitionMigrationLifecycle).toHaveBeenCalledTimes(1);
      expect(patchPlanStepAtomically).toHaveBeenCalledTimes(1);
    },
  );

  it('repairs only the sandbox flag on an assigned correction, preserving its status and infrastructure budget', async () => {
    loadPlan(assignedPlan([row], { requires_sandbox: false, infrastructure_generation: 3 }));
    await scheduleMigrationCorrectionStep({ requirementId: 'req', planId: 'plan', executionOwnership: ownership });
    expect(patchPlanStepAtomically).toHaveBeenCalledWith(expect.objectContaining({
      expectedGeneration: 3, patch: { requires_sandbox: true },
    }));
    expect(transitionMigrationLifecycle).not.toHaveBeenCalled();
  });

  it('does not claim tools are enabled if capability patch persistence fails', async () => {
    loadPlan(assignedPlan([row], { requires_sandbox: false }));
    (patchPlanStepAtomically as jest.Mock).mockResolvedValue({ persisted: false });
    await expect(scheduleMigrationCorrectionStep({ requirementId: 'req', planId: 'plan', executionOwnership: ownership }))
      .rejects.toThrow('enable sandbox');
    expect(transitionMigrationLifecycle).not.toHaveBeenCalled();
  });

  it('uses distinct assignment events for a new lifecycle revision of the same SQL in one run', async () => {
    await scheduleMigrationCorrectionStep({ requirementId: 'req', planId: 'plan', executionOwnership: ownership });
    (listMigrationLifecycle as jest.Mock).mockResolvedValue([{ ...row, version: 3, attempts: 2 }]);
    await scheduleMigrationCorrectionStep({ requirementId: 'req', planId: 'plan', executionOwnership: ownership });
    const events = (patchPlanStepAtomically as jest.Mock).mock.calls.map(([call]) => call.eventId);
    expect(events[0]).not.toBe(events[1]);
  });

  it('defers exhausted work to an independent diagnostic after sandbox provisioning, not an immediate hold', async () => {
    (listMigrationLifecycle as jest.Mock).mockResolvedValue([{ ...row, attempts: 5 }]);
    expect(await scheduleMigrationCorrectionStep({ requirementId: 'req', planId: 'plan', executionOwnership: ownership })).toEqual({ scheduled: false, internalReview: false, diagnosticPending: true });
    expect(patchPlanStepAtomically).not.toHaveBeenCalled();
    expect(transitionMigrationLifecycle).not.toHaveBeenCalled();
    expect(obtainMigrationDiagnosis).not.toHaveBeenCalled();
  });

  it('assigns a different diagnostic follow-up before acknowledging the durable handoff', async () => {
    (listMigrationLifecycle as jest.Mock).mockResolvedValue([{ ...row, attempts: 5 }]);
    const diagnosis = { decision: 'repair_candidate', reason: 'A scoped membership predicate is missing.',
      hypothesis: 'Use the protected membership relation.', instruction: 'Implement the verified membership predicate.',
      verification: 'Verify owner and unrelated-user authorization.', evidence: [], next_action: 'Repair and validate' };
    (obtainMigrationDiagnosis as jest.Mock).mockResolvedValue({ token: 'token', result: diagnosis });
    const result = await scheduleMigrationCorrectionStep({ requirementId: 'req', planId: 'plan', executionOwnership: ownership, sandboxId: 'sandbox' });
    expect(result).toMatchObject({ scheduled: true, internalReview: false, diagnosis });
    expect(transitionMigrationLifecycle).not.toHaveBeenCalled();
    expect(patchPlanStepAtomically).toHaveBeenCalledWith(expect.objectContaining({ patch: expect.objectContaining({
      status: 'pending', requires_sandbox: true, metadata: expect.objectContaining({ migration_diagnostic_token: 'token' }),
    }) }));
    expect(assignMigrationDiagnosticFollowup).toHaveBeenCalledWith(expect.objectContaining({ file: row.file }), 'token');
    expect((patchPlanStepAtomically as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan((assignMigrationDiagnosticFollowup as jest.Mock).mock.invocationCallOrder[0]);
  });

  it('does not acknowledge follow-up when its executable plan assignment failed', async () => {
    (listMigrationLifecycle as jest.Mock).mockResolvedValue([{ ...row, attempts: 5 }]);
    (obtainMigrationDiagnosis as jest.Mock).mockResolvedValue({ token: 'token', result: {
      decision: 'repair_candidate', hypothesis: 'New', instruction: 'Fix', verification: 'Test', evidence: [],
    } });
    (patchPlanStepAtomically as jest.Mock).mockResolvedValue({ persisted: false });
    await expect(scheduleMigrationCorrectionStep({ requirementId: 'req', planId: 'plan', executionOwnership: ownership, sandboxId: 'sandbox' })).rejects.toThrow('assign');
    expect(assignMigrationDiagnosticFollowup).not.toHaveBeenCalled();
  });

  it('allows the next cycle to execute an already assigned pending follow-up instead of diagnosing forever', async () => {
    (listMigrationLifecycle as jest.Mock).mockResolvedValue([{ ...row, attempts: 5 }]);
    (loadMigrationDiagnostic as jest.Mock).mockResolvedValue({ state: 'followup_assigned', token: 'token', execution_generation: 2, specification_checksum: row.specification_checksum });
    (supabaseAdmin.from as jest.Mock).mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: {
      ...plan, steps: [{ ...plan.steps[0], status: 'pending', metadata: { migration_diagnostic_token: 'token', migration_diagnostic_file: row.file } }],
    } }) }) }) });
    expect(await scheduleMigrationCorrectionStep({ requirementId: 'req', planId: 'plan', executionOwnership: ownership })).toEqual({ scheduled: true, internalReview: false });
    expect(obtainMigrationDiagnosis).not.toHaveBeenCalled();
    expect(patchPlanStepAtomically).not.toHaveBeenCalled();
  });

  it('settles an evidence-insufficient diagnostic atomically, never describing it as irreparable', async () => {
    (listMigrationLifecycle as jest.Mock).mockResolvedValue([{ ...row, attempts: 5 }]);
    (obtainMigrationDiagnosis as jest.Mock).mockResolvedValue({ token: 'token', result: {
      decision: 'unresolved', reason: 'No verified ownership model', next_action: 'Inspect the membership contract', evidence: [],
    } });
    expect(await scheduleMigrationCorrectionStep({ requirementId: 'req', planId: 'plan', executionOwnership: ownership, sandboxId: 'sandbox' })).toMatchObject({ scheduled: false, internalReview: true });
    expect(holdMigrationDiagnostic).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'plan', 'step', expect.stringContaining('Unresolved automatically'));
    expect(assignMigrationDiagnosticFollowup).not.toHaveBeenCalled();
  });

  it('refuses a plan owned by another requirement', async () => {
    (supabaseAdmin.from as jest.Mock).mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { ...plan, metadata: { requirement_id: 'other' } } }) }) }) });
    await expect(scheduleMigrationCorrectionStep({ requirementId: 'req', planId: 'plan', executionOwnership: ownership })).rejects.toThrow('does not belong');
    expect(patchPlanStepAtomically).not.toHaveBeenCalled();
  });

  const validation = { sandboxId: 'sandbox', requirementId: 'req', instanceId: 'instance', siteId: 'site', userId: 'user',
    instanceType: 'applications', title: 'Title', requirementType: 'app', plan, audit: { siteId: 'site' }, executionOwnership: ownership };

  it('only completes durable validation after matching ledger and fresh gate success', async () => {
    (listMigrationLifecycle as jest.Mock).mockResolvedValue([{ ...row, state: 'validation_pending' }]);
    expect(await verifyPendingMigrationLifecycleStep(validation)).toEqual({ passed: true, effectiveSandboxId: 'recovered' });
    expect(runGateStep).toHaveBeenCalledWith(expect.objectContaining({ freshMigrationValidation: true, expectedRepairs: [expect.objectContaining({ checksum: row.checksum })] }));
    expect(transitionMigrationLifecycle).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 1, value: expect.objectContaining({ state: 'validated' }) }));
  });

  it('does not clear pending evidence after a failed or unavailable gate', async () => {
    (listMigrationLifecycle as jest.Mock).mockResolvedValue([{ ...row, state: 'validation_pending' }]);
    (runGateStep as jest.Mock).mockResolvedValue({ passed: false, infrastructureFailure: true, effectiveSandboxId: 'recovered' });
    expect((await verifyPendingMigrationLifecycleStep(validation)).passed).toBe(false);
    expect(transitionMigrationLifecycle).not.toHaveBeenCalled();
  });
});