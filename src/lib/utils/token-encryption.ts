import * as crypto from "crypto";

/**
 * AES-256-CBC token encryption.
 * Format: iv:encryptedContent (hex) — same as /api/secure-tokens/encrypt
 */
export function encryptToken(value: string): string {
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) {
    throw new Error("Missing ENCRYPTION_KEY environment variable");
  }

  const iv = crypto.randomBytes(16);
  const key = crypto.createHash("sha256").update(String(encryptionKey)).digest();
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(value, "utf8")), cipher.final()]);
  return `${iv.toString("hex")}:${encrypted.toString("hex")}`;
}
