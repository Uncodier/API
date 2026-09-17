import { isSandboxGoneError } from '../sandbox-gone-error';

describe('isSandboxGoneError', () => {
  it('detects 410 Gone + stopped execution', () => {
    expect(
      isSandboxGoneError('Sandbox has stopped execution (410 Gone). Something went wrong.'),
    ).toBe(true);
  });

  it('detects 410 status code without gone', () => {
    expect(isSandboxGoneError('Status code 410 is not ok')).toBe(true);
  });

  it('detects 404 status code (sandbox missing)', () => {
    expect(isSandboxGoneError('Status code 404 is not ok')).toBe(true);
    expect(isSandboxGoneError('status code 404')).toBe(true);
  });

  it('detects microVM unavailable wording', () => {
    expect(isSandboxGoneError('The sandbox microVM is unavailable. Please retry.')).toBe(true);
  });

  it('detects a closed sandbox command stream', () => {
    expect(
      isSandboxGoneError('Sandbox stream was closed and is not accepting commands.'),
    ).toBe(true);
    expect(
      isSandboxGoneError('The sandbox command stream is closed.'),
    ).toBe(true);
  });

  it('returns false for normal git errors', () => {
    expect(isSandboxGoneError('fatal: refusing to merge unrelated histories')).toBe(false);
  });

  it('detects SDK APIError-shaped objects and Retry-After copy', () => {
    expect(isSandboxGoneError({ status: 410, message: 'Gone' })).toBe(true);
    expect(isSandboxGoneError({ statusCode: 404, message: 'not found' })).toBe(true);
    expect(isSandboxGoneError('APIError: sandbox unavailable (Retry-After: 2) 410')).toBe(true);
  });
});
