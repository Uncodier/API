import crypto from "crypto";

const MAX_SIGNATURE_AGE_SECONDS = 5 * 60;
const MAX_FUTURE_CLOCK_SKEW_SECONDS = 60;

export type ZavuSignatureCheck = {
  valid: boolean;
  format: "missing" | "legacy_hex" | "versioned" | "unsupported";
  reason:
    | "verified"
    | "missing_signature"
    | "missing_secret"
    | "empty_payload"
    | "malformed_signature"
    | "expired_signature"
    | "future_signature"
    | "signature_mismatch";
};

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
export function checkZavuSignature(
  signature: string | null | undefined,
  payload: string | Buffer,
  secret: string | undefined
): ZavuSignatureCheck {
  const format: ZavuSignatureCheck["format"] = !signature?.trim()
    ? "missing"
    : /^[a-f0-9]{64}$/i.test(signature.trim())
      ? "legacy_hex"
      : /(?:^|,)\s*(?:t|v1|v2)\s*=/i.test(signature)
        ? "versioned"
        : "unsupported";
  const result = (reason: ZavuSignatureCheck["reason"]): ZavuSignatureCheck => ({
    valid: reason === "verified",
    format,
    reason,
  });
  if (!signature?.trim()) return result("missing_signature");
  if (!secret) return result("missing_secret");
  if (!payload || payload.length === 0) return result("empty_payload");

  try {
    const rawBody = typeof payload === "string" ? payload : payload.toString("utf8");

    // Some legacy Zavu tool webhooks send the v1 digest without a version.
    if (format === "legacy_hex") {
      const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
      return result(matchesHexSignature(expected, signature) ? "verified" : "signature_mismatch");
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
      return result("malformed_signature");
    }
    const timestamp = Number(parts.t);
    if (!Number.isSafeInteger(timestamp)) {
      return result("malformed_signature");
    }
    const ageSeconds = Math.floor(Date.now() / 1000) - timestamp;
    if (ageSeconds > MAX_SIGNATURE_AGE_SECONDS) return result("expired_signature");
    if (ageSeconds < -MAX_FUTURE_CLOCK_SKEW_SECONDS) return result("future_signature");

    const received = parts.v2 || parts.v1;
    if (!received || !/^[a-f0-9]{64}$/i.test(received)) {
      return result("malformed_signature");
    }
    const signedPayload = parts.v2 ? `${parts.t}.${rawBody}` : rawBody;
    const expected = crypto
      .createHmac("sha256", secret)
      .update(signedPayload)
      .digest();

    return result(matchesHexSignature(expected, received) ? "verified" : "signature_mismatch");
  } catch {
    return result("malformed_signature");
  }
}

/** Keep the shared webhook verifier fail-closed; diagnostics never include credentials. */
export function verifyZavuSignature(
  signature: string | null | undefined,
  payload: string | Buffer,
  secret: string | undefined
): boolean {
  return checkZavuSignature(signature, payload, secret).valid;
}
