import { createHmac } from 'crypto';
import { verifyVercelWebhookSignature } from '../webhook-verification';

const SECRET = 'super-secret';
const BODY = JSON.stringify({ id: 'evt_1', type: 'deployment.created' });

function sign(body: string, secret: string): string {
  return createHmac('sha1', secret).update(body, 'utf8').digest('hex');
}

describe('verifyVercelWebhookSignature', () => {
  test('accepts a valid hex HMAC-SHA1 signature', () => {
    const sig = sign(BODY, SECRET);
    expect(verifyVercelWebhookSignature(BODY, sig, SECRET)).toBe(true);
  });

  test('accepts a signature prefixed with "sha1="', () => {
    const sig = `sha1=${sign(BODY, SECRET)}`;
    expect(verifyVercelWebhookSignature(BODY, sig, SECRET)).toBe(true);
  });

  test('rejects when the header is missing', () => {
    expect(verifyVercelWebhookSignature(BODY, null, SECRET)).toBe(false);
    expect(verifyVercelWebhookSignature(BODY, undefined, SECRET)).toBe(false);
  });

  test('rejects when the secret is empty', () => {
    const sig = sign(BODY, SECRET);
    expect(verifyVercelWebhookSignature(BODY, sig, '')).toBe(false);
  });

  test('rejects when the signature was produced with a different secret', () => {
    const sig = sign(BODY, 'other-secret');
    expect(verifyVercelWebhookSignature(BODY, sig, SECRET)).toBe(false);
  });

  test('rejects when the body was tampered', () => {
    const sig = sign(BODY, SECRET);
    expect(verifyVercelWebhookSignature(`${BODY}x`, sig, SECRET)).toBe(false);
  });

  test('rejects when the signature length differs (does not throw)', () => {
    expect(verifyVercelWebhookSignature(BODY, 'deadbeef', SECRET)).toBe(false);
  });
});
