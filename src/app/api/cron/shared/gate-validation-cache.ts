import type { EvidenceRecord } from '@/lib/services/requirement-evidence-types';
import type { TestSignal } from './step-test-evidence';

export interface ReusableGateValidation {
  buildPassed: true;
  tests?: TestSignal;
}

export function selectReusableGateValidation(params: {
  evidence?: EvidenceRecord | null;
  stepId: string;
  workspaceFingerprint?: string;
  testCommand?: string;
}): ReusableGateValidation | undefined {
  const {
    evidence,
    stepId,
    workspaceFingerprint,
    testCommand,
  } = params;
  if (
    !evidence ||
    !workspaceFingerprint ||
    evidence.producer_step_id !== stepId ||
    evidence.workspace_fingerprint !== workspaceFingerprint ||
    evidence.build?.exit_code !== 0
  ) {
    return undefined;
  }

  if (!testCommand) {
    return { buildPassed: true };
  }

  const receipt = evidence.tests?.find((test) =>
    test.command === testCommand &&
    test.exit_code === 0 &&
    test.ran_after_changes === true &&
    test.step_id === stepId &&
    test.workspace_fingerprint === workspaceFingerprint
  );
  if (!receipt) return undefined;

  return {
    buildPassed: true,
    tests: {
      ok: true,
      tests: [{
        ...receipt,
        captured_at: receipt.captured_at || evidence.captured_at,
      }],
    },
  };
}

export function shouldResumeGateFromEvidence(params: {
  evidence?: EvidenceRecord | null;
  stepId: string;
  workspaceFingerprint?: string;
  testCommand?: string;
}): boolean {
  const marker = params.evidence?.gate_resume;
  return (
    marker?.status === 'pending' &&
    marker.step_id === params.stepId &&
    marker.workspace_fingerprint === params.workspaceFingerprint &&
    !!selectReusableGateValidation(params)
  );
}
