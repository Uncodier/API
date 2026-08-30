import crypto from "crypto";

export * from "./client";
export * from "./persist";

const MAX_AGE_SECONDS = 300;

function parseSignatureHeader(header: string): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const piece of header.split(",")) {
    const index = piece.indexOf("=");
    if (index > 0) {
      parts[piece.slice(0, index).trim()] = piece.slice(index + 1).trim();
    }
  }
  return parts;
}

/**
 * Verify X-Zavu-Signature.
 * v2 = HMAC_SHA256(secret, "{t}.{body}")
 * v1 = HMAC_SHA256(secret, body)
 */
export const verifyZavuSignature = (
  signature: string | null | undefined,
  payload: string | Buffer,
  secret: string | undefined
): boolean => {
  if (!signature || !secret || !payload) {
    return false;
  }

  try {
    const rawBody = typeof payload === "string" ? payload : payload.toString("utf8");
    const parts = parseSignatureHeader(signature);
    const timestamp = Number(parts.t);
    if (!Number.isFinite(timestamp)) {
      return false;
    }

    const age = Math.floor(Date.now() / 1000) - timestamp;
    if (age > MAX_AGE_SECONDS || age < -60) {
      return false;
    }

    const received = parts.v2 ?? parts.v1;
    if (!received) {
      return false;
    }

    const signedPayload = parts.v2 ? `${timestamp}.${rawBody}` : rawBody;
    const expected = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");
    if (expected.length !== received.length) {
      return false;
    }

    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
  } catch (error) {
    console.error("Error verifying Zavu signature:", error);
    return false;
  }
};

export function mapInvitationStatus(status: string | undefined): string {
  if (status === "completed") return "connected";
  return status || "pending";
}
