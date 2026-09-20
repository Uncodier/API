import { describe, expect, it } from '@jest/globals';
import { assertSafeRemoteUrl } from '../safe-remote-url';

describe('assertSafeRemoteUrl', () => {
  it.each([
    'http://example.com/image.png',
    'https://127.0.0.1/image.png',
    'https://169.254.169.254/latest/meta-data',
    'https://100.64.0.1/image.png',
    'https://[::1]/image.png',
    'https://[::ffff:127.0.0.1]/image.png',
  ])('rejects unsafe URL %s', async (url) => {
    await expect(assertSafeRemoteUrl(url)).rejects.toThrow();
  });
});
