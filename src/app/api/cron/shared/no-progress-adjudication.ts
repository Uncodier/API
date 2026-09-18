export const NO_PROGRESS_ADJUDICATION_METADATA_KEY =
  'no_progress_adjudication';

type StepLike = {
  metadata?: Record<string, unknown>;
};

export function isNoProgressAdjudicationRequested(
  step: StepLike,
  executionGeneration: number,
): boolean {
  const value = step.metadata?.[NO_PROGRESS_ADJUDICATION_METADATA_KEY];
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { state?: unknown }).state === 'requested' &&
    (value as { execution_generation?: unknown }).execution_generation ===
      executionGeneration
  );
}
