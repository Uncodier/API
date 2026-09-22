import crypto from "crypto";
import { verifyZavuSignature } from "../signature";

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
});
