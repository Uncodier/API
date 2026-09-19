import crypto from "crypto";

/**
 * Verify X-Zavu-Signature.
 * Zavu signs the exact raw request body with HMAC-SHA256 and sends the
 * lowercase hexadecimal digest as the header value.
 */
export function verifyZavuSignature(
  signature: string | null | undefined,
  payload: string | Buffer,
  secret: string | undefined
): boolean {
  if (!signature || !secret || !payload) {
    return false;
  }

  try {
    const rawBody = typeof payload === "string" ? payload : payload.toString("utf8");
    const received = signature.trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(received)) {
      return false;
    }

    const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
    return crypto.timingSafeEqual(expected, Buffer.from(received, "hex"));
  } catch (error) {
    console.error("Error verifying Zavu signature:", error);
    return false;
  }
}
