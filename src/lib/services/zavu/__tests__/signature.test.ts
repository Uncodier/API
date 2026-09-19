import crypto from "crypto";
import { verifyZavuSignature } from "../signature";

describe("verifyZavuSignature", () => {
  const secret = "whsec_test";
  const payload = JSON.stringify({
    tool: "capture_lead",
    arguments: { name: "Ada Lovelace", phone: "+14155550100" },
  });

  it("accepts Zavu's hexadecimal HMAC of the raw body", () => {
    const signature = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("hex");

    expect(verifyZavuSignature(signature, payload, secret)).toBe(true);
  });

  it("rejects legacy timestamped headers and altered payloads", () => {
    const signature = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("hex");

    expect(verifyZavuSignature(`t=1,v2=${signature}`, payload, secret)).toBe(false);
    expect(verifyZavuSignature(signature, `${payload} `, secret)).toBe(false);
  });
});
