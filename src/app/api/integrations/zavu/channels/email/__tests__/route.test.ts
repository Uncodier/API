import { NextRequest } from "next/server";
import { jest } from "@jest/globals";

const mockFunction = () => jest.fn<(...args: any[]) => any>();
const zavu = {
  createSender: mockFunction(),
  updateSender: mockFunction(),
  attachSenderToAgent: mockFunction(),
  upsertChannelConnection: mockFunction(),
  ensureSenderWebhook: mockFunction(),
  getChannelConnection: mockFunction(),
  requireZavuSiteManager: mockFunction(),
  verifyEmailDomain: mockFunction(),
};

jest.unstable_mockModule("@/lib/services/zavu", () => zavu);
jest.unstable_mockModule("@/lib/utils/token-encryption", () => ({
  encryptToken: jest.fn((value) => `enc:${value}`),
}));

let POST: typeof import("../route").POST;
let PUT: typeof import("../route").PUT;

beforeAll(async () => {
  ({ POST, PUT } = await import("../route"));
});

describe("POST /api/integrations/zavu/channels/email", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    zavu.requireZavuSiteManager.mockResolvedValue(undefined);
    zavu.getChannelConnection.mockResolvedValue(null);
    zavu.createSender.mockResolvedValue({
      id: "snd_1",
      channels: [],
      webhook: {
        url: "https://backend.makinari.com/api/integrations/zavu/webhook",
        events: ["message.inbound"],
        active: true,
        secret: "whsec_1",
      },
    });
    zavu.attachSenderToAgent.mockResolvedValue(null);
    zavu.upsertChannelConnection.mockResolvedValue({
      channelId: "channel_1",
    });
  });

  it("keeps a newly configured sender pending until activation", async () => {
    const request = new NextRequest(
      "http://localhost/api/integrations/zavu/channels/email",
      {
        method: "POST",
        body: JSON.stringify({
          siteId: "site_1",
          channelId: "channel_1",
          name: "Email",
          emailAddress: "team@mail.example.com",
          emailFromName: "Example",
          emailDomainId: "domain_1",
        }),
      }
    );

    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(zavu.upsertChannelConnection).toHaveBeenCalledWith(
      "site_1",
      "channel_1",
      expect.objectContaining({
        status: "in_progress",
        metadata: expect.objectContaining({
          emailChannelActive: false,
        }),
      })
    );
    expect(payload.sender).toEqual({
      id: "snd_1",
      channels: [],
    });
  });

  it("does not persist when updating a reused sender fails", async () => {
    zavu.getChannelConnection.mockResolvedValue({
      id: "channel_1",
      type: "email",
      zavu_sender_id: "snd_1",
      metadata: { email_domain_id: "domain_1" },
    });
    zavu.verifyEmailDomain.mockResolvedValue({ id: "domain_1", status: "verified" });
    zavu.updateSender.mockRejectedValue(new Error("vendor detail"));

    const request = new NextRequest(
      "http://localhost/api/integrations/zavu/channels/email",
      {
        method: "POST",
        body: JSON.stringify({
          siteId: "site_1",
          channelId: "channel_1",
          name: "Email",
          emailAddress: "team@mail.example.com",
          emailFromName: "Example",
          emailDomainId: "domain_1",
        }),
      }
    );
    const response = await POST(request);

    expect(response.status).toBe(502);
    expect(zavu.ensureSenderWebhook).not.toHaveBeenCalled();
    expect(zavu.upsertChannelConnection).not.toHaveBeenCalled();
    await expect(response.json()).resolves.not.toEqual(
      expect.objectContaining({ error: expect.stringContaining("vendor detail") })
    );
  });

  it("rejects invalid payloads before authorization or Zavu calls", async () => {
    const request = new NextRequest(
      "http://localhost/api/integrations/zavu/channels/email",
      { method: "POST", body: "not-json" }
    );

    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(zavu.requireZavuSiteManager).not.toHaveBeenCalled();
    expect(zavu.createSender).not.toHaveBeenCalled();
  });

  it("preserves authorization failures", async () => {
    const error = Object.assign(new Error("Forbidden"), { status: 403 });
    zavu.requireZavuSiteManager.mockRejectedValue(error);
    const request = new NextRequest(
      "http://localhost/api/integrations/zavu/channels/email",
      {
        method: "POST",
        body: JSON.stringify({
          siteId: "site_1",
          channelId: "channel_1",
          name: "Email",
          emailAddress: "team@mail.example.com",
          emailFromName: "Example",
          emailDomainId: "domain_1",
        }),
      }
    );

    const response = await POST(request);

    expect(response.status).toBe(403);
    expect(zavu.createSender).not.toHaveBeenCalled();
  });
});

function receivingRequest(emailReceivingEnabled: unknown = true) {
  return new NextRequest(
    "http://localhost/api/integrations/zavu/channels/email",
    {
      method: "PUT",
      body: JSON.stringify({
        siteId: "site_1",
        channelId: "channel_1",
        senderId: "snd_1",
        emailReceivingEnabled,
      }),
    }
  );
}

describe("PUT /api/integrations/zavu/channels/email", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    zavu.requireZavuSiteManager.mockResolvedValue(undefined);
    zavu.getChannelConnection.mockResolvedValue({
      id: "channel_1",
      type: "email",
      zavu_sender_id: "snd_1",
      metadata: { email_domain_id: "domain_1" },
    });
    zavu.verifyEmailDomain.mockResolvedValue({ id: "domain_1", status: "verified" });
    zavu.upsertChannelConnection.mockResolvedValue({
      channelId: "channel_1",
    });
  });

  it("updates Zavu and persists only the remotely confirmed value", async () => {
    zavu.updateSender.mockResolvedValue({
      id: "snd_1",
      emailReceivingEnabled: true,
    });

    const response = await PUT(receivingRequest());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(zavu.requireZavuSiteManager).toHaveBeenCalledWith(expect.any(NextRequest), "site_1");
    expect(zavu.verifyEmailDomain).toHaveBeenCalledWith("domain_1");
    expect(zavu.updateSender).toHaveBeenCalledWith("snd_1", {
      emailReceivingEnabled: true,
    });
    expect(zavu.upsertChannelConnection).toHaveBeenCalledWith(
      "site_1",
      "channel_1",
      { metadata: { emailReceivingEnabled: true, mx_verified: true } }
    );
    expect(payload.sender.emailReceivingEnabled).toBe(true);
  });

  it("returns and persists false when Zavu refuses receiving", async () => {
    zavu.updateSender.mockResolvedValue({
      id: "snd_1",
      emailReceivingEnabled: false,
    });

    const response = await PUT(receivingRequest());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(zavu.upsertChannelConnection).toHaveBeenCalledWith(
      "site_1",
      "channel_1",
      { metadata: { emailReceivingEnabled: false, mx_verified: false } }
    );
    expect(payload.sender.emailReceivingEnabled).toBe(false);
  });

  it("refreshes Zavu MX verification before enabling receiving", async () => {
    const calls: string[] = [];
    zavu.verifyEmailDomain.mockImplementation(async () => {
      calls.push("verify");
      return { id: "domain_1", status: "verified" };
    });
    zavu.updateSender.mockImplementation(async () => {
      calls.push("update");
      return { id: "snd_1", emailReceivingEnabled: true };
    });

    const response = await PUT(receivingRequest());

    expect(response.status).toBe(200);
    expect(calls).toEqual(["verify", "update"]);
  });

  it("does not enable receiving when Zavu MX verification fails", async () => {
    zavu.verifyEmailDomain.mockRejectedValue(new Error("MX has not propagated"));

    const response = await PUT(receivingRequest());

    expect(response.status).toBe(502);
    expect(zavu.updateSender).not.toHaveBeenCalled();
    expect(zavu.upsertChannelConnection).not.toHaveBeenCalled();
  });

  it("returns an actionable pending state without enabling receiving", async () => {
    zavu.verifyEmailDomain.mockResolvedValue({
      id: "domain_1",
      status: "pending",
      dnsRecords: [{ type: "MX" }],
    });

    const response = await PUT(receivingRequest());
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error).toMatch(/retry Verify MX/);
    expect(zavu.updateSender).not.toHaveBeenCalled();
    expect(zavu.upsertChannelConnection).toHaveBeenCalledWith(
      "site_1",
      "channel_1",
      { metadata: {
        domain_status: "pending",
        dns_records: [{ type: "MX" }],
        mx_verified: false,
      } }
    );
  });

  it("does not persist a response for a different remote sender", async () => {
    zavu.updateSender.mockResolvedValue({
      id: "snd_other",
      emailReceivingEnabled: true,
    });

    const response = await PUT(receivingRequest());

    expect(response.status).toBe(502);
    expect(zavu.upsertChannelConnection).not.toHaveBeenCalled();
  });

  it("rejects non-boolean values before calling Zavu", async () => {
    const response = await PUT(receivingRequest("false"));

    expect(response.status).toBe(400);
    expect(zavu.updateSender).not.toHaveBeenCalled();
  });

  it("rejects a sender that does not belong to the channel", async () => {
    zavu.getChannelConnection.mockResolvedValue({
      id: "channel_1",
      type: "email",
      zavu_sender_id: "snd_other",
    });

    const response = await PUT(receivingRequest());

    expect(response.status).toBe(409);
    expect(zavu.updateSender).not.toHaveBeenCalled();
  });

  it("preserves authorization failures and does not call Zavu", async () => {
    const error = Object.assign(new Error("Forbidden"), { status: 403 });
    zavu.requireZavuSiteManager.mockRejectedValue(error);

    const response = await PUT(receivingRequest());

    expect(response.status).toBe(403);
    expect(zavu.updateSender).not.toHaveBeenCalled();
  });
});
