import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { jest } from "@jest/globals";

const mockFunction = () => jest.fn<(...args: any[]) => any>();
const zavu = {
  ensureSenderChannelActive: mockFunction(),
  getChannelConnection: mockFunction(),
  isChannelActivationBlocked: (c: any) => c?.enabled === false || c?.license_suspended === true || c?._license?.manually_disabled === true || ["disabled", "inactive", "suspended", "license_suspended"].includes(c?.status),
  requireZavuSiteManager: mockFunction(),
  upsertChannelConnection: mockFunction(),
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


let POST: typeof import("../route").POST;

beforeAll(async () => {
  ({ POST } = await import("../route"));
});

function activationRequest() {
  return new NextRequest(
    "http://localhost/api/integrations/zavu/senders/snd_1/channels/email/activate",
    {
      method: "POST",
      body: JSON.stringify({
        siteId: "site_1",
        channelId: "channel_1",
      }),
    }
  );
}

describe("POST /api/integrations/zavu/senders/:id/channels/email/activate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    zavu.requireZavuSiteManager.mockResolvedValue(undefined);
    zavu.getChannelConnection.mockResolvedValue({
      id: "channel_1",
      type: "email",
      zavu_sender_id: "snd_1",
    });
    zavu.upsertChannelConnection.mockResolvedValue({
      channelId: "channel_1",
    });
  });

  it("activates email and persists the connected state", async () => {
    zavu.ensureSenderChannelActive.mockResolvedValue({
      sender: { id: "snd_1", channels: ["email"] },
      channel: "email",
      activated: true,
      chargedCents: 0,
      monthlyCents: 0,
    });

    const response = await POST(activationRequest(), {
      params: Promise.resolve({ id: "snd_1" }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(zavu.ensureSenderChannelActive).toHaveBeenCalledWith("snd_1", "email");
    expect(zavu.upsertChannelConnection).toHaveBeenCalledWith(
      "site_1",
      "channel_1",
      {
        status: "connected",
        metadata: { emailChannelActive: true, activation_pending: false, provider_channel_active: true },
      }
    );
    expect(payload).toEqual(expect.objectContaining({
      success: true,
      activated: true,
      channel: "email",
    }));
  });

  it("rejects a sender that does not belong to the channel connection", async () => {
    zavu.getChannelConnection.mockResolvedValue({
      id: "channel_1",
      type: "email",
      zavu_sender_id: "snd_other",
    });

    const response = await POST(activationRequest(), {
      params: Promise.resolve({ id: "snd_1" }),
    });

    expect(response.status).toBe(409);
    expect(zavu.ensureSenderChannelActive).not.toHaveBeenCalled();
  });

  it("rejects a non-email connection", async () => {
    zavu.getChannelConnection.mockResolvedValue({
      id: "channel_1",
      type: "voice",
      zavu_sender_id: "snd_1",
    });

    const response = await POST(activationRequest(), {
      params: Promise.resolve({ id: "snd_1" }),
    });

    expect(response.status).toBe(409);
    expect(zavu.ensureSenderChannelActive).not.toHaveBeenCalled();
  });

  it("does not persist activation returned for a different sender", async () => {
    zavu.ensureSenderChannelActive.mockResolvedValue({
      sender: { id: "snd_other", channels: ["email"] },
      activated: true,
    });

    const response = await POST(activationRequest(), {
      params: Promise.resolve({ id: "snd_1" }),
    });

    expect(response.status).toBe(502);
    expect(zavu.upsertChannelConnection).toHaveBeenCalledTimes(1);
    expect(zavu.upsertChannelConnection).toHaveBeenCalledWith("site_1", "channel_1", { status: "in_progress", metadata: { activation_pending: true, emailChannelActive: false } });
  });

  it.each([{ enabled: false }, { license_suspended: true }, { _license: { manually_disabled: true } },
    { status: "disabled" }, { status: "suspended" }, { status: "license_suspended" }])("blocks disabled activation %j", async (state) => {
    zavu.getChannelConnection.mockResolvedValue({ type: "email", zavu_sender_id: "snd_1", ...state });
    const response = await POST(activationRequest(), { params: Promise.resolve({ id: "snd_1" }) });
    expect(response.status).toBe(409);
    expect(zavu.ensureSenderChannelActive).not.toHaveBeenCalled();
    expect(zavu.upsertChannelConnection).not.toHaveBeenCalled();
  });

  it("leaves activation pending and sanitizes provider errors", async () => {
    zavu.ensureSenderChannelActive.mockRejectedValue(new Error("private provider detail"));
    const response = await POST(activationRequest(), { params: Promise.resolve({ id: "snd_1" }) });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("private provider detail");
    expect(zavu.upsertChannelConnection).toHaveBeenCalledTimes(1);
    expect(zavu.upsertChannelConnection).toHaveBeenCalledWith("site_1", "channel_1", {
      status: "in_progress", metadata: { activation_pending: true, emailChannelActive: false },
    });
  });

  it("returns only safe sender fields while preserving activation pricing", async () => {
    const secret = randomBytes(32).toString("hex");
    zavu.ensureSenderChannelActive.mockResolvedValue({
      sender: { id: "snd_1", channels: ["email"], webhook: { secret } },
      activated: true, chargedCents: 100, monthlyCents: 100, channel: "email", debug: secret,
    });
    const response = await POST(activationRequest(), { params: Promise.resolve({ id: "snd_1" }) });
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(JSON.stringify(payload)).not.toContain(secret);
    expect(payload).toMatchObject({ chargedCents: 100, monthlyCents: 100, sender: { id: "snd_1", channels: ["email"] } });
    expect(payload.sender.webhook).toBeUndefined();
  });

  it("never activates if the existing-only pending write conflicts", async () => {
    patchActivationConnection.mockRejectedValueOnce(new Error("Concurrent deletion"));
    const response = await POST(activationRequest(), { params: Promise.resolve({ id: "snd_1" }) });
    expect(response.status).toBe(500);
    expect(zavu.ensureSenderChannelActive).not.toHaveBeenCalled();
    expect(patchActivationConnection).toHaveBeenCalledWith("site_1", "channel_1", expect.anything(), { type: "email", senderId: "snd_1" });
  });

  it("does not mark connected after a concurrent license suspension", async () => {
    zavu.ensureSenderChannelActive.mockImplementation(async () => {
      requireActivationLicense.mockRejectedValue(new Error("Suspended"));
      return { sender: { id: "snd_1", channels: ["email"] } };
    });
    const response = await POST(activationRequest(), { params: Promise.resolve({ id: "snd_1" }) });
    expect(response.status).toBe(500);
    expect(patchActivationConnection.mock.calls.some((call) => call[2].status === "connected")).toBe(false);
  });

  it("keeps an established connected slot occupied during verification", async () => {
    zavu.getChannelConnection.mockResolvedValue({ type: "email", zavu_sender_id: "snd_1", status: "connected" });
    zavu.ensureSenderChannelActive.mockRejectedValueOnce(new Error("Provider unavailable"));
    const response = await POST(activationRequest(), { params: Promise.resolve({ id: "snd_1" }) });
    expect(response.status).toBe(502);
    expect(patchActivationConnection).toHaveBeenCalledWith("site_1", "channel_1", expect.objectContaining({ status: "connected" }), { type: "email", senderId: "snd_1" });
    expect(patchActivationConnection.mock.calls.some((call) => call[2].status === "in_progress")).toBe(false);
  });
});
