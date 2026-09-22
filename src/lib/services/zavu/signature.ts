import crypto from "crypto";

const MAX_SIGNATURE_AGE_SECONDS = 5 * 60;
const MAX_FUTURE_CLOCK_SKEW_SECONDS = 60;

function matchesHexSignature(
  expected: Buffer,
  received: string | undefined
): boolean {
  const normalized = received?.trim().toLowerCase();
  if (!normalized || !/^[a-f0-9]{64}$/.test(normalized)) {
    return false;
  }

  return crypto.timingSafeEqual(expected, Buffer.from(normalized, "hex"));
}

/**
 * Verify X-Zavu-Signature.
 * Version 1 signs the raw body, while version 2 signs `{timestamp}.{rawBody}`.
 * Plain hexadecimal signatures remain supported for legacy tool webhooks.
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

    // Some legacy Zavu tool webhooks send the v1 digest without a version.
    if (/^[a-f0-9]{64}$/i.test(signature.trim())) {
      const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
      return matchesHexSignature(expected, signature);
    }

    const parts: Record<string, string> = {};
    for (const piece of signature.split(",")) {
      const separator = piece.indexOf("=");
      if (separator <= 0) continue;
      const key = piece.slice(0, separator).trim().toLowerCase();
      const value = piece.slice(separator + 1).trim();
      if (key && value) parts[key] = value;
    }

    if (!/^\d+$/.test(parts.t || "")) {
      return false;
    }
    const timestamp = Number(parts.t);
    if (!Number.isSafeInteger(timestamp)) {
      return false;
    }
    const ageSeconds = Math.floor(Date.now() / 1000) - timestamp;
    if (
      ageSeconds > MAX_SIGNATURE_AGE_SECONDS
      || ageSeconds < -MAX_FUTURE_CLOCK_SKEW_SECONDS
    ) {
      return false;
    }

    const received = parts.v2 || parts.v1;
    if (!received) {
      return false;
    }
    const signedPayload = parts.v2 ? `${parts.t}.${rawBody}` : rawBody;
    const expected = crypto
      .createHmac("sha256", secret)
      .update(signedPayload)
      .digest();

    return matchesHexSignature(expected, received);
  } catch (error) {
    console.error("Error verifying Zavu signature:", error);
    return false;
  }
}
