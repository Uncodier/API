async function deriveKey(
  password: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: 100_000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function encryptionSecret(): string {
  const value = process.env.ENCRYPTION_KEY;
  if (!value) throw new Error('Missing ENCRYPTION_KEY environment variable');
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('Web Crypto API is not available in this environment');
  }
  return value;
}

export function generateApiKey(prefix: string, length = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  const key = btoa(String.fromCharCode(...Array.from(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  return `${prefix}_${key}`;
}

export async function encryptApiKey(apiKey: string): Promise<string> {
  const secret = encryptionSecret();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(secret, salt);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    new TextEncoder().encode(apiKey),
  );
  const result = new Uint8Array(salt.length + iv.length + encrypted.byteLength);
  result.set(salt, 0);
  result.set(iv, salt.length);
  result.set(new Uint8Array(encrypted), salt.length + iv.length);
  return btoa(String.fromCharCode(...Array.from(result)));
}

async function decryptCurrentFormat(
  encryptedKey: string,
  secret: string,
): Promise<string> {
  const data = new Uint8Array(
    atob(encryptedKey).split('').map((character) => character.charCodeAt(0)),
  );
  if (data.length < 28) throw new Error('Invalid current key format');
  const salt = data.slice(0, 16);
  const iv = data.slice(16, 28);
  const key = await deriveKey(secret, salt);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    data.slice(28),
  );
  return new TextDecoder().decode(decrypted);
}

async function decryptLegacyFormat(
  encryptedKey: string,
  secret: string,
): Promise<string> {
  const keyData = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(secret),
  );
  const keyArray = new Uint8Array(keyData);
  const ivData = await crypto.subtle.digest('SHA-256', keyArray);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyArray,
    { name: 'AES-CBC' },
    false,
    ['decrypt'],
  );
  const encryptedData = new Uint8Array(
    atob(encryptedKey).split('').map((character) => character.charCodeAt(0)),
  );
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv: new Uint8Array(ivData).slice(0, 16) as BufferSource },
    cryptoKey,
    encryptedData,
  );
  return new TextDecoder().decode(decrypted);
}

export async function decryptApiKey(encryptedKey: string): Promise<string> {
  const secret = encryptionSecret();
  try {
    return await decryptCurrentFormat(encryptedKey, secret);
  } catch {
    try {
      return await decryptLegacyFormat(encryptedKey, secret);
    } catch {
      throw new Error('Invalid encrypted key format');
    }
  }
}
