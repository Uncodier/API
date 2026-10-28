/** Persisted per materialized run. Existing runs keep their original contract. */
export type WorkflowResultContractVersion = 1 | 2;
export const CURRENT_WORKFLOW_RESULT_CONTRACT_VERSION: WorkflowResultContractVersion = 2;

export function readWorkflowResultContractVersion(metadata: Record<string, unknown> | null | undefined): WorkflowResultContractVersion {
  const version = metadata?.result_contract_version;
  if (version === undefined) return 1;
  if (version === 1 || version === 2) return version;
  throw new Error('Unsupported workflow result contract version');
}