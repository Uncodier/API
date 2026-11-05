import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { jest } from "@jest/globals";
const mockFunction = () => jest.fn<(...args: any[]) => any>();
const botToken = randomBytes(32).toString("hex");
const webhookSecret = randomBytes(32).toString("hex");

const zavu = {
  createSender: mockFunction(),
  connectTelegram: mockFunction(),
  attachSenderToAgent: mockFunction(),
  upsertChannelConnection: mockFunction(),
  ensureSenderWebhook: mockFunction(),
  getChannelConnection: mockFunction(),
  requireZavuSiteManager: mockFunction(),
  ensureSenderChannelActive: mockFunction(),
  isChannelActivationBlocked: (c: any) => c?.enabled === false || c?.license_suspended === true || c?._license?.manually_disabled === true || ["disabled", "inactive", "suspended", "license_suspended"].includes(c?.status),
};
jest.unstable_mockModule("@/lib/services/zavu", () => zavu);
const prepareActivationWebhookSecret = mockFunction();
jest.unstable_mockModule("@/lib/services/zavu/activation-webhook-secret", () => ({ prepareActivationWebhookSecret }));
const patchActivationConnection = mockFunction();
const requireActivationLicense = mockFunction();
jest.unstable_mockModule("@/lib/services/zavu/activation-persistence", () => ({
  patchActivationConnection, requireActivationLicense,
}));
beforeEach(() => {
  prepareActivationWebhookSecret.mockReset().mockResolvedValue(undefined);
  patchActivationConnection.mockReset();
  requireActivationLicense.mockReset();
  patchActivationConnection.mockImplementation(async (site, id, patch) => {
    const result = await zavu.upsertChannelConnection(site, id, patch);
    return result?.connection;
  });
  requireActivationLicense.mockResolvedValue(undefined);
});

let POST: typeof import("../route").POST;
beforeAll(async () => { ({ POST } = await import("../route")); });

jest.unstable_mockModule("@/lib/utils/token-encryption", () => ({
  encryptToken: (value: string) => `enc:${value}`,
}));

describe("POST /api/integrations/zavu/channels/telegram", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    zavu.requireZavuSiteManager.mockResolvedValue(undefined);
    zavu.ensureSenderChannelActive.mockResolvedValue({ sender: { id: "snd_existing", channels: ["telegram"] } });
    (zavu.connectTelegram).mockResolvedValue({ telegram: { botUsername: "bot" } });
    (zavu.attachSenderToAgent).mockResolvedValue(null);
    (zavu.upsertChannelConnection).mockResolvedValue({ channelId: "ch_1" });
  });

  it("reuses zavu_sender_id when the front resends channelId", async () => {
    (zavu.getChannelConnection).mockResolvedValue({
      id: "ch_1",
      type: "telegram",
      zavu_sender_id: "snd_existing",
    });
    (zavu.ensureSenderWebhook).mockResolvedValue({
      id: "snd_existing",
      webhook: { url: "https://backend.makinari.com/api/integrations/zavu/webhook", events: ["message.inbound"], active: true },
    });

    const req = new NextRequest("http://localhost/api/integrations/zavu/channels/telegram", {
      method: "POST",
      body: JSON.stringify({
        siteId: "site-1",
        channelId: "ch_1",
        botToken,
        name: "Telegram",
      }),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(zavu.createSender).not.toHaveBeenCalled();
    expect(zavu.ensureSenderWebhook).toHaveBeenCalledWith("snd_existing");
    expect(zavu.connectTelegram).toHaveBeenCalledWith("snd_existing", botToken);
    expect(zavu.upsertChannelConnection).toHaveBeenCalledWith(
      "site-1",
      "ch_1",
      expect.objectContaining({ zavu_sender_id: "snd_existing" })
    );
    expect(json.senderId).toBe("snd_existing");
  });

  it("creates a sender when no existing zavu_sender_id is stored", async () => {
    zavu.ensureSenderChannelActive.mockResolvedValue({ sender: { id: "snd_new", channels: ["telegram"] } });
    (zavu.getChannelConnection).mockResolvedValue(null);
    zavu.createSender.mockImplementation(async (_params, options) => { const created = {
      id: "snd_new",
      webhook: { events: ["message.inbound"], secret: webhookSecret, active: true, url: "https://x/webhook" },
    }; await options?.onCreated(created); return created; });

    const req = new NextRequest("http://localhost/api/integrations/zavu/channels/telegram", {
      method: "POST",
      body: JSON.stringify({
        siteId: "site-1",
        botToken,
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(zavu.createSender).toHaveBeenCalledTimes(1);
    expect(zavu.upsertChannelConnection).toHaveBeenCalledWith(
      "site-1",
      undefined,
      expect.objectContaining({ zavu_sender_id: "snd_new" })
    );
  });
});

function request(overrides: Record<string, unknown> = {}) {
  return new NextRequest("https://api.example.test/api/integrations/zavu/channels/telegram", {
    method: "POST", body: JSON.stringify({ siteId: "site_1", channelId: "channel_1", botToken, ...overrides }),
  });
}

describe("Telegram activation safety", () => {
  let saved: any;
  beforeEach(() => {
    jest.clearAllMocks();
    saved = null;
    zavu.requireZavuSiteManager.mockResolvedValue(undefined);
    zavu.getChannelConnection.mockImplementation(async () => saved);
    zavu.createSender.mockImplementation(async (_params, options) => { const created = { id: "snd_1", channels: [], webhook: { secret: webhookSecret } }; await options?.onCreated(created); return created; });
    zavu.ensureSenderWebhook.mockResolvedValue({ id: "snd_1", webhook: { secret: webhookSecret } });
    zavu.connectTelegram.mockResolvedValue({ telegram: { botUsername: "example_bot", botId: "123", botToken } });
    zavu.ensureSenderChannelActive.mockResolvedValue({ sender: { id: "snd_1", channels: ["telegram"] } });
    zavu.upsertChannelConnection.mockImplementation(async (_site, _id, patch) => {
      saved = { ...saved, ...patch, metadata: { ...saved?.metadata, ...patch.metadata } };
      return { channelId: "channel_1", connection: saved };
    });
  });

  it("persists pending identity and secret before verified activation, without returning secrets", async () => {
    zavu.ensureSenderChannelActive.mockImplementation(async () => {
      expect(saved).toMatchObject({ zavu_sender_id: "snd_1", status: "in_progress", metadata: { activation_pending: true } });
      expect(saved.metadata.zavu_webhook_secret).toBeDefined();
      return { sender: { id: "snd_1", channels: ["telegram"] } };
    });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(zavu.requireZavuSiteManager).toHaveBeenCalledWith(expect.anything(), "site_1");
    expect(zavu.requireZavuSiteManager.mock.invocationCallOrder[0]).toBeLessThan(zavu.getChannelConnection.mock.invocationCallOrder[0]);
    expect(zavu.ensureSenderChannelActive).toHaveBeenCalledWith("snd_1", "telegram");
    expect(saved).toMatchObject({ status: "connected", metadata: { activation_pending: false } });
    const body = await response.text();
    expect(body).not.toContain(botToken);
    expect(body).not.toContain(webhookSecret);
  });

  it("reuses the saved sender after activation failure", async () => {
    zavu.ensureSenderChannelActive.mockRejectedValueOnce(new Error(botToken));
    const failed = await POST(request());
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain(botToken);
    expect(saved).toMatchObject({ status: "in_progress", metadata: { activation_pending: true } });
    expect((await POST(request())).status).toBe(200);
    expect(zavu.createSender).toHaveBeenCalledTimes(1);
    expect(zavu.ensureSenderWebhook).toHaveBeenCalledWith("snd_1");
    expect(saved.status).toBe("connected");
  });

  it.each([
    { enabled: false }, { license_suspended: true }, { _license: { manually_disabled: true } },
    { status: "disabled" }, { status: "license_suspended" }, { status: "inactive" }, { status: "suspended" },
    { type: "email" },
  ])("rejects unsafe connection reuse %j", async (state) => {
    saved = { type: "telegram", zavu_sender_id: "snd_1", ...state };
    expect((await POST(request())).status).toBe(409);
    expect(zavu.createSender).not.toHaveBeenCalled();
    expect(zavu.ensureSenderWebhook).not.toHaveBeenCalled();
    expect(zavu.connectTelegram).not.toHaveBeenCalled();
    expect(zavu.ensureSenderChannelActive).not.toHaveBeenCalled();
  });

  it.each([401, 403])("preserves authorization %i without provider or persistence access", async (status) => {
    zavu.requireZavuSiteManager.mockRejectedValue(Object.assign(new Error(botToken), { status }));
    const response = await POST(request());
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain(botToken);
    expect(zavu.getChannelConnection).not.toHaveBeenCalled();
    expect(zavu.createSender).not.toHaveBeenCalled();
  });

  it.each([{ siteId: " " }, { botToken: 123 }, { botToken: "" }, { channelId: false }])("validates %j", async (body) => {
    expect((await POST(request(body))).status).toBe(400);
    expect(zavu.requireZavuSiteManager).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    const response = await POST(new NextRequest("https://api.example.test", { method: "POST", body: "{" }));
    expect(response.status).toBe(400);
    expect(zavu.createSender).not.toHaveBeenCalled();
  });

  it("does not swallow reused sender webhook failures", async () => {
    saved = { type: "telegram", zavu_sender_id: "snd_1" };
    zavu.ensureSenderWebhook.mockRejectedValue(new Error(webhookSecret));
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(webhookSecret);
    expect(zavu.ensureSenderChannelActive).not.toHaveBeenCalled();
    expect(saved.status).toBe("in_progress");
  });

  it("rejects webhook identity mismatch", async () => {
    saved = { type: "telegram", zavu_sender_id: "snd_1" };
    zavu.ensureSenderWebhook.mockResolvedValue({ id: "snd_other" });
    expect((await POST(request())).status).toBe(502);
    expect(zavu.connectTelegram).not.toHaveBeenCalled();
  });

  it("fences an existing sender identity update against concurrent replacement", async () => {
    saved = { type: "telegram", zavu_sender_id: "snd_1" };
    patchActivationConnection.mockRejectedValueOnce(new Error("Channel changed"));
    expect((await POST(request())).status).toBe(502);
    expect(patchActivationConnection).toHaveBeenCalledWith("site_1", "channel_1", expect.anything(), { type: "telegram", senderId: "snd_1" });
    expect(zavu.upsertChannelConnection).not.toHaveBeenCalled();
    expect(zavu.connectTelegram).not.toHaveBeenCalled();
  });

  it("does not activate a newly suspended license", async () => {
    requireActivationLicense.mockRejectedValueOnce(new Error("Suspended"));
    expect((await POST(request())).status).toBe(502);
    expect(zavu.ensureSenderChannelActive).not.toHaveBeenCalled();
    expect(saved.status).toBe("in_progress");
  });

  it("does not overwrite a concurrent disable after provider activation", async () => {
    zavu.ensureSenderChannelActive.mockImplementation(async () => {
      saved.enabled = false;
      requireActivationLicense.mockRejectedValue(new Error("Disabled"));
      return { sender: { id: "snd_1", channels: ["telegram"] } };
    });
    expect((await POST(request())).status).toBe(502);
    expect(saved).toMatchObject({ enabled: false, status: "in_progress" });
    expect(patchActivationConnection.mock.calls.some((call) => call[2].status === "connected")).toBe(false);
  });

  it("does not create a sender after database lookup failure", async () => {
    zavu.getChannelConnection.mockRejectedValueOnce(new Error("Could not read channel settings"));
    expect((await POST(request())).status).toBe(502);
    expect(zavu.createSender).not.toHaveBeenCalled();
  });

  it("keeps an established connected slot occupied during retry", async () => {
    saved = { type: "telegram", zavu_sender_id: "snd_1", status: "connected" };
    zavu.ensureSenderChannelActive.mockRejectedValueOnce(new Error("Provider unavailable"));
    expect((await POST(request())).status).toBe(502);
    expect(saved.status).toBe("connected");
    expect(patchActivationConnection.mock.calls.some((call) => call[2].status === "in_progress")).toBe(false);
  });
  it.each([false, true])("initializes missing secret and fails closed: %s", async (fail) => {
    saved = { type: "telegram", zavu_sender_id: "snd_1" };
    zavu.ensureSenderWebhook.mockResolvedValue({ id: "snd_1" });
    if (fail) prepareActivationWebhookSecret.mockRejectedValueOnce(new Error("initializer failed"));
    expect((await POST(request())).status).toBe(fail ? 502 : 200);
    expect(prepareActivationWebhookSecret).toHaveBeenCalledWith("site_1", "channel_1", { type: "telegram", senderId: "snd_1" }, undefined);
    expect(zavu.ensureSenderWebhook.mock.invocationCallOrder[0]).toBeLessThan(prepareActivationWebhookSecret.mock.invocationCallOrder[0]);
    expect(zavu.ensureSenderChannelActive).toHaveBeenCalledTimes(fail ? 0 : 1);
  });
  it("reuses raw creation after webhook configuration fails", async () => {
    zavu.createSender.mockImplementationOnce(async (_params, options) => { await options.onCreated({ id: "snd_1" }); throw new Error("Webhook failed"); });
    expect((await POST(request())).status).toBe(502);
    expect(saved.zavu_sender_id).toBe("snd_1");
    expect((await POST(request())).status).toBe(200);
    expect(zavu.createSender).toHaveBeenCalledTimes(1);
  });

});
