import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { POST } from "../route";
import * as zavu from "@/lib/services/zavu";
import { patchActivationConnection, requireActivationLicense } from "@/lib/services/zavu/activation-persistence";

jest.mock("@/lib/services/zavu/activation-persistence", () => ({
  patchActivationConnection: jest.fn(), requireActivationLicense: jest.fn(),
}));

jest.mock("@/lib/services/zavu", () => ({
  assertPhoneResourcesAvailable: jest.fn(),
  assignNumberToSender: jest.fn(),
  attachSenderToAgent: jest.fn(),
  createSender: jest.fn(),
  ensureEncryptedSenderWebhookSecret: jest.fn(),
  ensureProjectWebhook: jest.fn(),
  ensureSenderWebhook: jest.fn(),
  getChannelConnection: jest.fn(),
  getOwnedNumbers: jest.fn(),
  isChannelActivationBlocked: jest.requireActual("@/lib/services/zavu/channel-activation").isChannelActivationBlocked,
  purchaseNumber: jest.fn(),
  requireZavuSiteManager: jest.fn(),
  upsertChannelConnection: jest.fn(),
  updateSender: jest.fn(),
  zavuFetch: jest.fn(),
  activateSenderChannel: jest.fn(),
  ensureSenderChannelActive: jest.fn(),
}));
jest.mock("@/lib/services/zavu/client", () => ({ activateSenderChannel: jest.fn(), zavuFetch: jest.fn() }));

const siteId = "00000000-0000-4000-8000-000000000001";
const channelId = "00000000-0000-4000-8000-000000000002";
const senderId = "sender/1";
const phoneNumber = "+12025550100";
const mock = (fn: unknown) => fn as jest.Mock;
let saved: any;
let secret: string;

function request(extra: Record<string, unknown> = {}) {
  return new NextRequest("http://localhost/api/integrations/zavu/sms", {
    method: "POST", body: JSON.stringify({ siteId, channelId, ...extra }),
  });
}

beforeEach(() => {
  jest.resetAllMocks();
  saved = null;
  secret = randomBytes(24).toString("hex");
  mock(zavu.getChannelConnection).mockImplementation(async () => saved);
  mock(zavu.createSender).mockResolvedValue({ id: senderId, webhook: { secret, events: ["message.inbound"] } });
  mock(zavu.ensureSenderWebhook).mockResolvedValue({ id: senderId, webhook: { events: ["message.inbound"] } });
  mock(zavu.ensureEncryptedSenderWebhookSecret).mockResolvedValue("encrypted-value");
  mock(zavu.upsertChannelConnection).mockImplementation(async (_site, id, patch) => {
    saved = { ...saved, ...patch, id: id || channelId, metadata: { ...saved?.metadata, ...patch.metadata } };
    return { channelId: saved.id, connection: saved };
  });
  mock(patchActivationConnection).mockImplementation(async (_site, id, patch, expected) => {
    if (!saved || saved.id !== id || saved.type !== expected.type
      || (saved.zavu_sender_id || null) !== expected.senderId || zavu.isChannelActivationBlocked(saved)) {
      throw new Error("Connection changed");
    }
    saved = { ...saved, ...patch, metadata: { ...saved.metadata, ...patch.metadata } };
    return saved;
  });
  mock(requireActivationLicense).mockImplementation(async () => {
    if (zavu.isChannelActivationBlocked(saved)) throw new Error("License suspended");
    return saved;
  });
  mock(zavu.zavuFetch).mockResolvedValue({ sender: { id: senderId, channels: ["sms_oneway"] } });
  mock(zavu.getOwnedNumbers).mockResolvedValue({ items: [] });
  mock(zavu.assignNumberToSender).mockResolvedValue({ phoneNumber: { phoneNumber, senderId, regulatoryStatus: "approved" } });
});

afterEach(() => {
  expect(zavu.activateSenderChannel).not.toHaveBeenCalled();
  expect(zavu.ensureSenderChannelActive).not.toHaveBeenCalled();
});

it.each(["sms", "sms_oneway"])("only connects after readback confirms %s membership", async (channel) => {
  mock(zavu.zavuFetch).mockImplementation(async () => {
    expect(saved).toMatchObject({ status: "in_progress", zavu_sender_id: senderId, metadata: { activation_pending: true } });
    return { id: senderId, channels: [channel] };
  });
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    success: true, channelId, senderId, status: "connected", activationPending: false, providerChannelActive: true,
  });
  expect(zavu.createSender).toHaveBeenCalledWith(expect.objectContaining({ enableSmsOneway: true }));
  expect(zavu.zavuFetch).toHaveBeenCalledWith("/senders/sender%2F1");
  expect(saved).toMatchObject({ status: "connected", metadata: { activation_pending: false, provider_channel_active: true } });
});

it("persists a pending sender before downstream setup and reuses it after failure", async () => {
  mock(zavu.ensureProjectWebhook).mockImplementationOnce(async () => {
    expect(saved).toMatchObject({ status: "in_progress", zavu_sender_id: senderId });
    throw new Error(secret);
  });
  const failed = await POST(request());
  expect(failed.status).toBe(502);
  expect(await failed.json()).toEqual({ error: "Zavu could not complete SMS setup", channelId, senderId });
  expect(saved.status).toBe("in_progress");
  expect((await POST(request())).status).toBe(200);
  expect(zavu.createSender).toHaveBeenCalledTimes(1);
  expect(zavu.updateSender).toHaveBeenCalledWith(senderId, { enableSmsOneway: true });
});

it.each([false, true])("preserves an established connected slot during a retry (failure=%s)", async (failure) => {
  saved = { id: channelId, type: "sms", status: "connected", zavu_sender_id: senderId };
  mock(requireActivationLicense).mockImplementation(async () => {
    expect(saved.status).toBe("connected");
    return saved;
  });
  mock(zavu.updateSender).mockImplementation(async () => {
    expect(saved).toMatchObject({ status: "connected", metadata: { activation_pending: true } });
    if (failure) throw new Error(secret);
  });
  const response = await POST(request());
  expect(response.status).toBe(failure ? 502 : 200);
  expect(saved.status).toBe("connected");
  expect(saved.metadata.activation_pending).toBe(failure);
  expect(mock(patchActivationConnection).mock.calls.every(([, , patch]) => patch.status !== "in_progress")).toBe(true);
});

it.each(["pending_review", "rejected", "pending", "in_review", "under_review", undefined])(
  "does not report connected for a requested phone with regulatory state %s despite one-way membership", async (regulatoryStatus) => {
    mock(zavu.assignNumberToSender).mockResolvedValue({ phoneNumber: { phoneNumber, senderId, regulatoryStatus } });
    const response = await POST(request({ phoneNumber }));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: "Zavu could not complete SMS setup", channelId, senderId });
    expect(saved).toMatchObject({ status: "in_progress", metadata: { activation_pending: true, provider_channel_active: false } });
    expect(zavu.zavuFetch).not.toHaveBeenCalled();
  },
);

it.each([{ phoneNumber: "+12025550101", senderId }, { phoneNumber, senderId: "other" }])(
  "rejects mismatched assigned phone identity %j", async (identity) => {
    mock(zavu.assignNumberToSender).mockResolvedValue({ ...identity, regulatoryStatus: "approved" });
    expect((await POST(request({ phoneNumber }))).status).toBe(502);
    expect(saved.status).toBe("in_progress");
  },
);

it.each([
  { id: senderId, channels: [] },
  { id: senderId, channels: ["email"] },
  { id: "other", channels: ["sms"] },
  { id: senderId, channels: "sms" },
  { id: senderId, smsActive: true },
  { success: true },
])("does not mark unconfirmed SMS readiness connected: %j", async (response) => {
  mock(zavu.zavuFetch).mockResolvedValue(response);
  expect((await POST(request())).status).toBe(502);
  expect(saved).toMatchObject({ status: "in_progress", metadata: { provider_channel_active: false } });
});

it.each([
  "ensureSenderWebhook", "ensureEncryptedSenderWebhookSecret", "updateSender",
  "getOwnedNumbers", "purchaseNumber", "assignNumberToSender", "attachSenderToAgent", "zavuFetch",
] as const)("does not connect or leak provider errors when %s fails", async (operation) => {
  saved = { id: channelId, type: "sms", zavu_sender_id: senderId, status: "pending" };
  mock(zavu[operation]).mockRejectedValue(Object.assign(new Error(secret), { status: 401 }));
  const response = await POST(request({ phoneNumber }));
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain(secret);
  expect(saved.status).toBe("in_progress");
  expect(saved.metadata.provider_channel_active).toBe(false);
});

it.each([
  { enabled: false }, { license_suspended: true }, { _license: { manually_disabled: true } },
  { status: "disabled" }, { status: "inactive" }, { status: "suspended" }, { status: "license_suspended" },
  { type: "email" },
])("rejects disabled, suspended, and mismatched connections: %j", async (state) => {
  saved = { id: channelId, type: "sms", zavu_sender_id: senderId, ...state };
  expect((await POST(request())).status).toBe(409);
  expect(zavu.createSender).not.toHaveBeenCalled();
  expect(zavu.updateSender).not.toHaveBeenCalled();
  expect(zavu.upsertChannelConnection).not.toHaveBeenCalled();
  expect(zavu.zavuFetch).not.toHaveBeenCalled();
});

it.each([401, 403])("authorizes existing connections before provider access (%s)", async (status) => {
  saved = { id: channelId, type: "sms", zavu_sender_id: senderId };
  mock(zavu.requireZavuSiteManager).mockRejectedValue(Object.assign(new Error(secret), { status }));
  const response = await POST(request());
  expect(response.status).toBe(status);
  expect(await response.text()).not.toContain(secret);
  expect(zavu.getChannelConnection).not.toHaveBeenCalled();
  expect(zavu.createSender).not.toHaveBeenCalled();
  expect(zavu.updateSender).not.toHaveBeenCalled();
});

it("preserves the saved phone number and avoids repurchasing an owned number on retry", async () => {
  saved = { id: channelId, type: "sms", zavu_sender_id: senderId, metadata: { phone_number: phoneNumber } };
  mock(zavu.getOwnedNumbers).mockResolvedValue({ items: [{ phoneNumber }] });
  expect((await POST(request())).status).toBe(200);
  expect(zavu.assertPhoneResourcesAvailable).toHaveBeenCalledWith(siteId, { phoneNumber });
  expect(zavu.purchaseNumber).not.toHaveBeenCalled();
  expect(zavu.assignNumberToSender).toHaveBeenCalledWith(senderId, phoneNumber);
});

it("stops before purchasing or assigning when the pending sender cannot be saved", async () => {
  mock(zavu.upsertChannelConnection).mockRejectedValue(new Error(secret));
  expect((await POST(request({ phoneNumber }))).status).toBe(502);
  expect(zavu.purchaseNumber).not.toHaveBeenCalled();
  expect(zavu.assignNumberToSender).not.toHaveBeenCalled();
});

it("rejects projected license suspension before reconfiguring an existing sender", async () => {
  saved = { id: channelId, type: "sms", zavu_sender_id: senderId };
  mock(requireActivationLicense).mockRejectedValue(new Error(secret));
  expect((await POST(request())).status).toBe(502);
  expect(zavu.updateSender).not.toHaveBeenCalled();
  expect(zavu.ensureSenderWebhook).not.toHaveBeenCalled();
  expect(patchActivationConnection).not.toHaveBeenCalled();
});

it.each(["disabled", "deleted", "replaced"])("does not restore a %s channel during readiness readback", async (change) => {
  mock(zavu.zavuFetch).mockImplementation(async () => {
    if (change === "disabled") saved.enabled = false;
    if (change === "deleted") saved = null;
    if (change === "replaced") saved.zavu_sender_id = "replacement";
    return { id: senderId, channels: ["sms"] };
  });
  expect((await POST(request())).status).toBe(502);
  expect(saved?.status).not.toBe("connected");
  expect(zavu.upsertChannelConnection).toHaveBeenCalledTimes(1);
  if (change === "disabled") expect(saved.enabled).toBe(false);
  if (change === "deleted") expect(saved).toBeNull();
  if (change === "replaced") expect(saved.zavu_sender_id).toBe("replacement");
});

it.each([{ siteId: "invalid" }, { channelId: "invalid" }, { senderId: "untrusted" }])("validates input %j", async (body) => {
  expect((await POST(request(body))).status).toBe(400);
  expect(zavu.requireZavuSiteManager).not.toHaveBeenCalled();
});

it("rejects malformed JSON", async () => {
  const response = await POST(new NextRequest("http://localhost/api/integrations/zavu/sms", { method: "POST", body: "{" }));
  expect(response.status).toBe(400);
  expect(zavu.requireZavuSiteManager).not.toHaveBeenCalled();
});