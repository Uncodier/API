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
