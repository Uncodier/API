import 'server-only';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { OpenRouterError } from './types';
function encryptionKey(): Buffer {
  const value = process.env.OPENROUTER_CREDENTIAL_ENCRYPTION_KEY;
  if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new OpenRouterError('encryption_unavailable', 'Connection encryption is not configured');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new OpenRouterError('encryption_unavailable', 'Connection encryption is not configured');
  return key;
}
// Authenticated context prevents swapping ciphertext across tenants or key revisions.
function aad(siteId: string, connectionId: string, version: number): Buffer {
  return Buffer.from(JSON.stringify(['openrouter', 1, siteId, connectionId, version]));
}
export function encryptCredential(apiKey: string, siteId: string, connectionId: string, version: number): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(aad(siteId, connectionId, version));
  const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.');
}
export function decryptCredential(value: string, siteId: string, connectionId: string, version: number): string {
  const key = encryptionKey();
  try {
    const [format, iv, tag, ciphertext, extra] = value.split('.');
    if (format !== 'v1' || extra || !iv || !tag || !ciphertext) throw new Error();
    if (Buffer.from(iv, 'base64').length !== 12 || Buffer.from(tag, 'base64').length !== 16) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAAD(aad(siteId, connectionId, version));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
  } catch { throw new OpenRouterError('credential_unavailable', 'Connection credential could not be decrypted'); }
}
