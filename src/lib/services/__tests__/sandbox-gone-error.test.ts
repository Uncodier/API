import { isSandboxGoneError } from '../sandbox-gone-error';

describe('isSandboxGoneError', () => {
  it('detects 410 Gone + stopped execution', () => {
    expect(
      isSandboxGoneError('Sandbox has stopped execution (410 Gone). Something went wrong.'),
    ).toBe(true);
  });

  it('detects microVM unavailable wording', () => {
    expect(isSandboxGoneError('The sandbox microVM is unavailable. Please retry.')).toBe(true);
  });

  it('returns false for normal git errors', () => {
    expect(isSandboxGoneError('fatal: refusing to merge unrelated histories')).toBe(false);
  });
});
