import { NextRequest } from "next/server";
import { jest } from "@jest/globals";

const mockFunction = () => jest.fn<(...args: any[]) => any>();
const zavu = {
  createSender: mockFunction(),
  ensureSenderChannelActive: mockFunction(),
  isChannelActivationBlocked: (c: any) => c?.enabled === false || c?.license_suspended === true || c?._license?.manually_disabled === true || ["disabled", "inactive", "suspended", "license_suspended"].includes(c?.status),
  updateSender: mockFunction(),
  attachSenderToAgent: mockFunction(),
  upsertChannelConnection: mockFunction(),
  ensureSenderWebhook: mockFunction(),
  getChannelConnection: mockFunction(),
  requireZavuSiteManager: mockFunction(),
  verifyEmailDomain: mockFunction(),
};

jest.unstable_mockModule("@/lib/services/zavu", () => zavu);
const patchActivationConnection = mockFunction();
const requireActivationLicense = mockFunction();
jest.unstable_mockModule("@/lib/services/zavu/activation-persistence", () => ({
  patchActivationConnection, requireActivationLicense,
}));
beforeEach(() => {
  patchActivationConnection.mockReset();
  requireActivationLicense.mockReset();
  patchActivationConnection.mockImplementation(async (site, id, patch) => {
    const result = await zavu.upsertChannelConnection(site, id, patch);
    return result?.connection;
  });
  requireActivationLicense.mockResolvedValue(undefined);
});

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

describe("Email setup automatic activation", () => {
  let saved: any;
  function setupRequest() {
    return new NextRequest("https://api.example.test/api/integrations/zavu/channels/email", {
      method: "POST", body: JSON.stringify({ siteId: "site_1", channelId: "channel_1",
        emailAddress: "team@example.test", emailFromName: "Example", emailDomainId: "domain_1" }),
    });
  }
  beforeEach(() => {
    jest.clearAllMocks();
    saved = { type: "email", metadata: { email_domain_id: "domain_1", domain_status: "verified" } };
    zavu.requireZavuSiteManager.mockResolvedValue(undefined);
    zavu.getChannelConnection.mockImplementation(async () => saved);
    zavu.createSender.mockResolvedValue({ id: "snd_1", channels: [] });
    zavu.updateSender.mockResolvedValue({ id: "snd_1", channels: [] });
    zavu.ensureSenderWebhook.mockResolvedValue({ id: "snd_1" });
    zavu.ensureSenderChannelActive.mockResolvedValue({ sender: { id: "snd_1", channels: ["email"] } });
    zavu.upsertChannelConnection.mockImplementation(async (_site, _id, patch) => {
      saved = { ...saved, ...patch, metadata: { ...saved?.metadata, ...patch.metadata } };
      return { channelId: "channel_1", connection: saved };
    });
  });

  it("saves sender pending before activation and only then marks connected", async () => {
    zavu.ensureSenderChannelActive.mockImplementation(async () => {
      expect(saved).toMatchObject({ zavu_sender_id: "snd_1", status: "in_progress", metadata: { emailChannelActive: false, activation_pending: true } });
      return { sender: { id: "snd_1", channels: ["email"] } };
    });
    const response = await POST(setupRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sender: { id: "snd_1", channels: ["email"] } });
    expect(saved).toMatchObject({ status: "connected", metadata: { emailChannelActive: true, activation_pending: false, domain_status: "verified", mx_verified: false } });
    expect(zavu.ensureSenderChannelActive).toHaveBeenCalledWith("snd_1", "email");
    expect(zavu.verifyEmailDomain).not.toHaveBeenCalled();
  });

  it("leaves an unverified domain pending without activating or falsely verifying DNS", async () => {
    saved.metadata.domain_status = "pending";
    const response = await POST(setupRequest());
    expect(response.status).toBe(200);
    expect(zavu.ensureSenderChannelActive).not.toHaveBeenCalled();
    expect(saved).toMatchObject({ status: "in_progress", metadata: { domain_status: "pending", emailChannelActive: false, mx_verified: false } });
  });

  it("retries a failed activation using the saved sender", async () => {
    const detail = `provider-${Math.random()}`;
    zavu.ensureSenderChannelActive.mockRejectedValueOnce(new Error(detail));
    const failed = await POST(setupRequest());
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain(detail);
    expect(saved).toMatchObject({ status: "in_progress", metadata: { activation_pending: true } });
    expect((await POST(setupRequest())).status).toBe(200);
    expect(zavu.createSender).toHaveBeenCalledTimes(1);
    expect(zavu.updateSender).toHaveBeenCalledWith("snd_1", { emailAddress: "team@example.test", emailFromName: "Example" });
    expect(saved.status).toBe("connected");
  });

  it.each([{ enabled: false }, { license_suspended: true }, { _license: { manually_disabled: true } },
    { status: "disabled" }, { status: "license_suspended" }, { type: "telegram" }])("blocks unsafe reuse %j", async (state) => {
    saved = { ...saved, zavu_sender_id: "snd_1", ...state };
    expect((await POST(setupRequest())).status).toBe(409);
    expect(zavu.updateSender).not.toHaveBeenCalled();
    expect(zavu.createSender).not.toHaveBeenCalled();
    expect(zavu.ensureSenderChannelActive).not.toHaveBeenCalled();
  });

  it("rejects a different domain before updating the sender", async () => {
    saved.metadata.email_domain_id = "domain_other";
    expect((await POST(setupRequest())).status).toBe(409);
    expect(zavu.createSender).not.toHaveBeenCalled();
  });

  it("does not swallow webhook failure on retry", async () => {
    saved.zavu_sender_id = "snd_1";
    zavu.ensureSenderWebhook.mockRejectedValue(new Error("provider detail"));
    const response = await POST(setupRequest());
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("provider detail");
    expect(zavu.ensureSenderChannelActive).not.toHaveBeenCalled();
    expect(saved.status).toBe("in_progress");
  });

  it("uses existing-only CAS for the initial sender identity and preserves concurrent deletion", async () => {
    patchActivationConnection.mockRejectedValueOnce(new Error("Deleted"));
    expect((await POST(setupRequest())).status).toBe(500);
    expect(patchActivationConnection).toHaveBeenCalledWith("site_1", "channel_1", expect.objectContaining({ zavu_sender_id: "snd_1" }), { type: "email", senderId: null });
    expect(zavu.upsertChannelConnection).not.toHaveBeenCalled();
    expect(zavu.ensureSenderChannelActive).not.toHaveBeenCalled();
  });

  it("rechecks projected license before activation", async () => {
    requireActivationLicense.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Suspended"));
    expect((await POST(setupRequest())).status).toBe(502);
    expect(zavu.ensureSenderChannelActive).not.toHaveBeenCalled();
    expect(saved.status).toBe("in_progress");
  });

  it("does not overwrite a concurrent disable after activation", async () => {
    zavu.ensureSenderChannelActive.mockImplementation(async () => {
      saved.enabled = false;
      requireActivationLicense.mockRejectedValue(new Error("Disabled"));
      return { sender: { id: "snd_1", channels: ["email"] } };
    });
    expect((await POST(setupRequest())).status).toBe(502);
    expect(saved).toMatchObject({ enabled: false, status: "in_progress" });
    expect(patchActivationConnection.mock.calls.some((call) => call[2].status === "connected")).toBe(false);
  });

  it("keeps an established connected slot occupied during retry", async () => {
    saved = { ...saved, zavu_sender_id: "snd_1", status: "connected" };
    zavu.ensureSenderChannelActive.mockRejectedValueOnce(new Error("Provider unavailable"));
    expect((await POST(setupRequest())).status).toBe(502);
    expect(saved.status).toBe("connected");
    expect(patchActivationConnection.mock.calls.some((call) => call[2].status === "in_progress")).toBe(false);
  });
});
