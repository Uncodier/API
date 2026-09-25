import type { Sandbox } from '@vercel/sandbox';
import { randomUUID } from 'node:crypto';
import type { EvidenceRecord } from '@/lib/services/requirement-evidence-types';
import { writeEvidence } from '@/lib/services/requirement-ground-truth';
import { extractTestEvidenceFromResult } from './step-test-evidence';
import { extractAgentProbeEvidence } from './step-agent-probe-evidence';
import type { JudgeRepairRun } from './judge-repair-controller';

interface GateTest {
  command: string;
  exit_code: number;
  output_tail: string;
  ran_after_changes: boolean;
  captured_at: string;
  step_id?: string;
  workspace_fingerprint?: string;
}

export async function prepareSingleTurnGateEvidence(params: {
  sandbox: Sandbox;
  cwd: string;
  requirementId: string;
  backlogItemId: string | null;
  stepId: string;
  persistedErrorMessage?: string;
  result: any;
  backlogEvidence?: EvidenceRecord;
  workspaceFingerprint?: string;
  validatedFingerprint?: string;
  gateTests?: GateTest[];
  gateBuild?: { ok: boolean; duration_ms?: number };
  gateObservations?: NonNullable<EvidenceRecord['observations']>;
  transientGateFailure: boolean;
  repairRun?: JudgeRepairRun;
}): Promise<{
  tests: GateTest[];
  observations: NonNullable<EvidenceRecord['observations']>;
  scenarioAssertions: NonNullable<EvidenceRecord['scenario_assertions']>;
  evidenceRunId: string;
  build?: NonNullable<EvidenceRecord['build']>;
}> {
  const persistedTests = params.validatedFingerprint
    ? (params.backlogEvidence?.tests || [])
        .filter((test) =>
          test.step_id === params.stepId &&
          test.workspace_fingerprint === params.validatedFingerprint)
        .map((test) => ({
          ...test,
          captured_at:
            test.captured_at || params.backlogEvidence!.captured_at,
        }))
    : [];
  const currentTests = extractTestEvidenceFromResult(params.result).map(
    (test) => ({
      ...test,
      step_id: params.stepId,
      ...(params.workspaceFingerprint
        ? { workspace_fingerprint: params.workspaceFingerprint }
        : {}),
      ran_after_changes:
        test.ran_after_changes &&
        !(
          params.workspaceFingerprint &&
          params.validatedFingerprint &&
          params.workspaceFingerprint !== params.validatedFingerprint
        ),
    }),
  );
  const gateTests = (params.gateTests || []).map((test) => ({
    ...test,
    step_id: test.step_id || params.stepId,
    ...(test.workspace_fingerprint || !params.validatedFingerprint
      ? {}
      : { workspace_fingerprint: params.validatedFingerprint }),
  }));
  const tests = Array.from(new Map(
    [...persistedTests, ...currentTests, ...gateTests].map((test) => [
      [
        test.step_id || params.stepId,
        test.command,
        test.workspace_fingerprint || '',
      ].join(':'),
      test,
    ]),
  ).values());
  const agentEvidence = extractAgentProbeEvidence(params.result);
  const observations = [
    ...(params.gateObservations || []),
    ...agentEvidence.observations,
  ];
  const targetResolutions = Array.from(new Map(
    observations
      .map((observation) => observation.target_resolution)
      .filter((resolution) => !!resolution)
      .map((resolution) => [
        [
          resolution!.criterion_id,
          resolution!.kind,
          resolution!.method || 'GET',
          resolution!.path,
        ].join(':'),
        resolution!,
      ]),
  ).values());
  // Every gate attempt gets its own identity. Reusing the rejected run made it
  // impossible to prove that a repair produced fresh evidence.
  const evidenceRunId = randomUUID();
  const reusedEvidenceRunIds = persistedTests.length > 0 &&
    params.backlogEvidence?.evidence_run_id
      ? [params.backlogEvidence.evidence_run_id]
      : [];
  const capturedEvidence = currentTests.length > 0 || gateTests.length > 0 ||
    observations.length > 0 || agentEvidence.scenario_assertions.length > 0 ||
    !!params.gateBuild;
  const evidenceProvenance: NonNullable<EvidenceRecord['evidence_provenance']> = {
    mode: reusedEvidenceRunIds.length > 0
      ? capturedEvidence ? 'mixed' : 'reused'
      : 'captured',
    reused_from_evidence_run_ids: reusedEvidenceRunIds,
  };
  const successfulReceipts = (params.repairRun?.action_receipts || [])
    .filter((receipt) =>
      receipt.repair_run_id === params.repairRun?.repair_run_id &&
      receipt.status === 'succeeded')
    .map((receipt) => receipt.receipt_id);
  const repairProvenance =
    params.repairRun?.status === 'materialized' && successfulReceipts.length > 0
      ? {
          diagnostic_id: params.repairRun.diagnostic_id,
          repair_run_id: params.repairRun.repair_run_id,
          source_evidence_run_id: params.repairRun.source_evidence_run_id,
          action_ids: params.repairRun.actions.map((action) => action.action_id),
          receipt_ids: successfulReceipts,
        }
      : undefined;
  const build = params.gateBuild
    ? {
        command: 'npm run build',
        exit_code: params.gateBuild.ok ? 0 : 1,
        duration_ms: params.gateBuild.duration_ms ?? 0,
      }
    : undefined;

  if (
    params.backlogItemId &&
    (
      tests.length > 0 ||
      observations.length > 0 ||
      agentEvidence.scenario_assertions.length > 0 ||
      build
    )
  ) {
    await writeEvidence({
      sandbox: params.sandbox,
      cwd: params.cwd,
      requirementId: params.requirementId,
      itemId: params.backlogItemId,
      record: {
        evidence_run_id: evidenceRunId,
        producer_step_id: params.stepId,
        workspace_fingerprint: params.validatedFingerprint,
        captured_at: new Date().toISOString(),
        evidence_provenance: evidenceProvenance,
        repair_provenance: repairProvenance,
        tests,
        build,
        observations,
        target_resolutions: targetResolutions,
        scenario_assertions: agentEvidence.scenario_assertions,
        gate_resume:
          params.transientGateFailure &&
          build?.exit_code === 0 &&
          params.validatedFingerprint
            ? {
                status: 'pending',
                step_id: params.stepId,
                workspace_fingerprint: params.validatedFingerprint,
                captured_at: new Date().toISOString(),
              }
            : null,
      },
    });
  }

  return {
    tests,
    observations,
    scenarioAssertions: agentEvidence.scenario_assertions,
    evidenceRunId,
    build,
  };
}
