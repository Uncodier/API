import { NextRequest } from "next/server";
import { jest } from "@jest/globals";

const mockFunction = () => jest.fn<(...args: any[]) => any>();
const zavu = {
  getChannelConnection: mockFunction(),
  requireZavuSiteManager: mockFunction(),
  upsertChannelConnection: mockFunction(),
  verifyEmailDomain: mockFunction(),
};

jest.unstable_mockModule("@/lib/services/zavu", () => zavu);

let POST: typeof import("../route").POST;

beforeAll(async () => {
  ({ POST } = await import("../route"));
});

function verificationRequest(body: unknown = { siteId: "site_1", channelId: "channel_1" }) {
  return new NextRequest(
    "http://localhost/api/integrations/zavu/email-domains/domain_1/verify",
    { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }
  );
}

function verify(domainId = "domain_1", request = verificationRequest()) {
  return POST(request, { params: Promise.resolve({ id: domainId }) });
}

describe("POST /api/integrations/zavu/email-domains/:id/verify", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    zavu.requireZavuSiteManager.mockResolvedValue(undefined);
    zavu.getChannelConnection.mockResolvedValue({
      id: "channel_1",
      type: "email",
      metadata: {
        email_domain_id: "domain_1",
        dns_records: [{ type: "TXT" }],
      },
    });
    zavu.verifyEmailDomain.mockResolvedValue({
      id: "domain_1",
      status: "verified",
      dnsRecords: [{ type: "MX" }],
    });
    zavu.upsertChannelConnection.mockResolvedValue({ channelId: "channel_1" });
  });

  it("authorizes ownership, verifies the matching domain, and persists it", async () => {
    const response = await verify();

    expect(response.status).toBe(200);
    expect(zavu.requireZavuSiteManager).toHaveBeenCalledWith(expect.any(NextRequest), "site_1");
    expect(zavu.getChannelConnection).toHaveBeenCalledWith("site_1", "channel_1");
    expect(zavu.verifyEmailDomain).toHaveBeenCalledWith("domain_1");
    expect(zavu.upsertChannelConnection).toHaveBeenCalledWith("site_1", "channel_1", {
      metadata: {
        domain_status: "verified",
        dns_records: [{ type: "MX" }],
      },
    });
  });

  it("rejects malformed input before authorization or Zavu calls", async () => {
    const response = await verify("domain_1", verificationRequest("not-json"));

    expect(response.status).toBe(400);
    expect(zavu.requireZavuSiteManager).not.toHaveBeenCalled();
    expect(zavu.verifyEmailDomain).not.toHaveBeenCalled();
  });

  it("preserves authorization failures without calling Zavu", async () => {
    zavu.requireZavuSiteManager.mockRejectedValue(
      Object.assign(new Error("Forbidden"), { status: 403 })
    );

    const response = await verify();

    expect(response.status).toBe(403);
    expect(zavu.getChannelConnection).not.toHaveBeenCalled();
    expect(zavu.verifyEmailDomain).not.toHaveBeenCalled();
  });

  it("returns unauthorized when no authenticated identity exists", async () => {
    zavu.requireZavuSiteManager.mockRejectedValue(
      Object.assign(new Error("Unauthorized"), { status: 401 })
    );

    const response = await verify();

    expect(response.status).toBe(401);
    expect(zavu.getChannelConnection).not.toHaveBeenCalled();
    expect(zavu.verifyEmailDomain).not.toHaveBeenCalled();
  });

  it("rejects a domain that does not belong to the channel", async () => {
    zavu.getChannelConnection.mockResolvedValue({
      id: "channel_1",
      type: "email",
      metadata: { email_domain_id: "domain_other" },
    });

    const response = await verify();

    expect(response.status).toBe(409);
    expect(zavu.verifyEmailDomain).not.toHaveBeenCalled();
    expect(zavu.upsertChannelConnection).not.toHaveBeenCalled();
  });

  it("rejects a missing channel connection", async () => {
    zavu.getChannelConnection.mockResolvedValue(null);

    const response = await verify();

    expect(response.status).toBe(404);
    expect(zavu.verifyEmailDomain).not.toHaveBeenCalled();
  });

  it("does not persist a response for a different remote domain", async () => {
    zavu.verifyEmailDomain.mockResolvedValue({ id: "domain_other", status: "verified" });

    const response = await verify();

    expect(response.status).toBe(502);
    expect(zavu.upsertChannelConnection).not.toHaveBeenCalled();
  });
});