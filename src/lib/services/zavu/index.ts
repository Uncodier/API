import crypto from "crypto";

export * from "./client";
export * from "./persist";
export * from "./webhook-handlers";

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
    console.warn("[Zavu Webhook] Missing signature, secret, or payload", { hasSignature: !!signature, hasSecret: !!secret, hasPayload: !!payload });
    return false;
  }

  try {
    const rawBody = typeof payload === "string" ? payload : payload.toString("utf8");
    const parts = parseSignatureHeader(signature);
    const timestamp = Number(parts.t);
    if (!Number.isFinite(timestamp)) {
      console.warn("[Zavu Webhook] Invalid timestamp in signature:", parts.t);
      return false;
    }

    const age = Math.floor(Date.now() / 1000) - timestamp;
    if (age > MAX_AGE_SECONDS || age < -60) {
      console.warn(`[Zavu Webhook] Signature expired. Age: ${age}s (t=${timestamp}, now=${Math.floor(Date.now() / 1000)})`);
      return false;
    }

    const received = parts.v2 ?? parts.v1;
    if (!received) {
      console.warn("[Zavu Webhook] Missing v1 or v2 in signature header");
      return false;
    }

    // Usar rawBody para firmar, ya que el header se firma con el payload original,
    // que idealmente debería ser JSON plano, pero al hacer JSON.parse(await request.text()) a veces hay desajustes.
    // Zavu requiere firmar EXACTAMENTE con request.text().
    const signedPayload = parts.v2 ? `${timestamp}.${rawBody}` : rawBody;
    const expected = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");
    if (expected.length !== received.length) {
      console.warn(`[Zavu Webhook] Length mismatch. Expected: ${expected.length}, Received: ${received.length}`);
      return false;
    }

    const isValid = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
    if (!isValid) {
      console.warn(`[Zavu Webhook] Signature mismatch. Version: ${parts.v2 ? 'v2' : 'v1'}`);
      console.warn(`[Zavu Webhook] Expected: ${expected.substring(0, 10)}... Received: ${received.substring(0, 10)}...`);
    }
    return isValid;
  } catch (error) {
    console.error("Error verifying Zavu signature:", error);
    return false;
  }
};
