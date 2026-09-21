import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  issuePublicImageSignature,
  verifyPublicImageSignature,
} from '../public-image-signature';

const input = {
  siteId: '11111111-1111-4111-8111-111111111111',
  prompt: 'A branded product photo',
  width: 800,
  height: 600,
};

describe('public image signatures', () => {
  beforeEach(() => {
    process.env.PUBLIC_MEDIA_SIGNING_SECRET = 'test-signing-secret';
    jest.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  });

  afterEach(() => {
    delete process.env.PUBLIC_MEDIA_SIGNING_SECRET;
    jest.restoreAllMocks();
  });

  it('issues a signature bound to site, prompt, dimensions, and expiry', () => {
    const issued = issuePublicImageSignature(input, 300);

    expect(verifyPublicImageSignature(
      input,
      String(issued.expires),
      issued.signature,
    )).toBe(true);
    expect(verifyPublicImageSignature(
      { ...input, width: 801 },
      String(issued.expires),
      issued.signature,
    )).toBe(false);
  });

  it('rejects expired and malformed signatures', () => {
    const issued = issuePublicImageSignature(input, 60);
    jest.spyOn(Date, 'now').mockReturnValue(1_800_000_061_000);

    expect(verifyPublicImageSignature(
      input,
      String(issued.expires),
      issued.signature,
    )).toBe(false);
    expect(verifyPublicImageSignature(input, 'invalid', 'not-a-signature'))
      .toBe(false);
  });
});
