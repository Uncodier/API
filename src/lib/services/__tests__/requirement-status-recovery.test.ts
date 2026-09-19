import { preserveUserActionRecovery } from '../requirement-status-recovery';

describe('preserveUserActionRecovery', () => {
  it.each(['blocked', 'failed'])(
    'prevents a stale %s write from undoing user recovery',
    (stage) => {
      expect(preserveUserActionRecovery({
        stage,
        message: 'Old execution result',
        recoveredFromUserAction: true,
      })).toEqual({
        stage: 'in-progress',
        message:
          'Execution resumed after recent user feedback; stale blocking status was ignored.',
      });
    },
  );

  it('preserves a blocking result when no recovery happened', () => {
    expect(preserveUserActionRecovery({
      stage: 'blocked',
      message: 'Needs input',
      recoveredFromUserAction: false,
    })).toEqual({
      stage: 'blocked',
      message: 'Needs input',
    });
  });
});
