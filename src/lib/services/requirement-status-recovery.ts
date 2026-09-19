export function preserveUserActionRecovery(input: {
  stage: string;
  message?: string;
  recoveredFromUserAction: boolean;
}): { stage: string; message?: string } {
  if (
    input.recoveredFromUserAction &&
    (input.stage === 'blocked' || input.stage === 'failed')
  ) {
    return {
      stage: 'in-progress',
      message:
        'Execution resumed after recent user feedback; stale blocking status was ignored.',
    };
  }
  return { stage: input.stage, message: input.message };
}

export function assertRequirementReopenAuthorized(input: {
  currentStatus?: string | null;
  nextStatus?: string | null;
  recoveredFromUserAction: boolean;
}): void {
  if (
    input.currentStatus === 'blocked' &&
    input.nextStatus === 'in-progress' &&
    !input.recoveredFromUserAction
  ) {
    throw new Error(
      'Cannot reopen a blocked requirement without a scoped user action',
    );
  }
}
