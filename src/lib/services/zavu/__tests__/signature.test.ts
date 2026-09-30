import crypto from "crypto";
import { checkZavuSignature, verifyZavuSignature } from "../signature";

describe("verifyZavuSignature", () => {
  const secret = "whsec_test";
  const payload = JSON.stringify({
    tool: "capture_lead",
    arguments: { name: "Ada Lovelace", phone: "+14155550100" },
  });

  function sign(value: string): string {
    return crypto.createHmac("sha256", secret).update(value).digest("hex");
  }

  it("accepts a legacy hexadecimal HMAC of the raw body", () => {
    expect(verifyZavuSignature(sign(payload), payload, secret)).toBe(true);
  });

  it("accepts a current v2 signature", () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = sign(`${timestamp}.${payload}`);

    expect(
      verifyZavuSignature(`t=${timestamp},v2=${signature}`, payload, secret)
    ).toBe(true);
  });

  it("accepts v1 and v2 during signature migration", () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const v1 = sign(payload);
    const v2 = sign(`${timestamp}.${payload}`);

    expect(
      verifyZavuSignature(
        `t=${timestamp},v1=${v1},v2=${v2}`,
        payload,
        secret
      )
    ).toBe(true);
  });

  it("does not fall back to v1 when a supplied v2 signature is invalid", () => {
    const timestamp = Math.floor(Date.now() / 1000);

    expect(
      verifyZavuSignature(
        `t=${timestamp},v1=${sign(payload)},v2=${"0".repeat(64)}`,
        payload,
        secret
      )
    ).toBe(false);
  });

  it("accepts a versioned v1 signature", () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("hex");

    expect(
      verifyZavuSignature(`t=${timestamp},v1=${signature}`, payload, secret)
    ).toBe(true);
  });

  it("rejects stale or excessively future-dated signatures", () => {
    const now = Math.floor(Date.now() / 1000);
    const staleTimestamp = now - 600;
    const futureTimestamp = now + 120;

    expect(
      verifyZavuSignature(
        `t=${staleTimestamp},v2=${sign(`${staleTimestamp}.${payload}`)}`,
        payload,
        secret
      )
    ).toBe(false);
    expect(
      verifyZavuSignature(
        `t=${futureTimestamp},v2=${sign(`${futureTimestamp}.${payload}`)}`,
        payload,
        secret
      )
    ).toBe(false);
  });

  it("rejects malformed signatures and altered payloads", () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = sign(`${timestamp}.${payload}`);

    expect(verifyZavuSignature(`v2=${signature}`, payload, secret)).toBe(false);
    expect(
      verifyZavuSignature(
        `t=${timestamp},v2=${signature}`,
        `${payload} `,
        secret
      )
    ).toBe(false);
  });

  it("reports safe reasons without including payloads or credentials", () => {
    expect(checkZavuSignature(null, payload, secret)).toEqual({
      valid: false, format: "missing", reason: "missing_signature",
    });
    expect(checkZavuSignature(sign(payload), payload, undefined)).toMatchObject({
      valid: false, reason: "missing_secret",
    });
    expect(checkZavuSignature("Bearer private", payload, secret)).toEqual({
      valid: false, format: "unsupported", reason: "malformed_signature",
    });
    expect(checkZavuSignature(sign(payload), `${payload} `, secret)).toEqual({
      valid: false, format: "legacy_hex", reason: "signature_mismatch",
    });
    expect(checkZavuSignature(sign(payload), payload, secret)).toEqual({
      valid: true, format: "legacy_hex", reason: "verified",
    });
    expect(checkZavuSignature(sign(payload), Buffer.alloc(0), secret)).toMatchObject({
      valid: false, reason: "empty_payload",
    });
  });

  it("distinguishes expired and future signatures without weakening timestamp validation", () => {
    const now = Math.floor(Date.now() / 1000);
    for (const [timestamp, reason] of [
      [now - 600, "expired_signature"],
      [now + 120, "future_signature"],
    ] as const) {
      expect(checkZavuSignature(
        `t=${timestamp},v2=${sign(`${timestamp}.${payload}`)}`, payload, secret
      )).toEqual({ valid: false, format: "versioned", reason });
    }
  });

  it("never accepts a bearer secret, missing header, or arbitrary digest prefix", () => {
    for (const signature of [secret, `Bearer ${secret}`, `sha256=${sign(payload)}`, "", null]) {
      expect(verifyZavuSignature(signature, payload, secret)).toBe(false);
    }
  });
});
