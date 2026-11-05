import { activateChannelConnection } from "../connection-activation";
import { ensureSenderWebhook } from "../client";
import { ensureSenderChannelActive } from "../channel-activation";
import { getChannelConnection } from "../persist";
import { patchActivationConnection, requireActivationLicense } from "../activation-persistence";
import { prepareActivationWebhookSecret } from "../activation-webhook-secret";

jest.mock("../client", () => ({ ensureSenderWebhook: jest.fn() }));
jest.mock("../channel-activation", () => ({
  ...jest.requireActual("../channel-activation"), ensureSenderChannelActive: jest.fn(),
}));
jest.mock("../persist", () => ({ getChannelConnection: jest.fn() }));
jest.mock("../activation-persistence", () => ({ patchActivationConnection: jest.fn(), requireActivationLicense: jest.fn() }));
jest.mock("../activation-webhook-secret", () => ({ prepareActivationWebhookSecret: jest.fn() }));

let connection: any;
beforeEach(() => {
  jest.resetAllMocks();
  connection = { id: "channel", type: "whatsapp", status: "pending", zavu_sender_id: "sender", metadata: {} };
  (getChannelConnection as jest.Mock).mockImplementation(async () => connection);
  (patchActivationConnection as jest.Mock).mockImplementation(async (_site, _id, patch) => {
    connection = { ...connection, ...patch, metadata: { ...connection.metadata, ...patch.metadata } };
    return connection;
  });
  (ensureSenderWebhook as jest.Mock).mockResolvedValue({ id: "sender", webhook: { events: ["message.inbound"] } });
  (prepareActivationWebhookSecret as jest.Mock).mockImplementation(async () => { connection.metadata.zavu_webhook_secret = "encrypted"; });
  (ensureSenderChannelActive as jest.Mock).mockResolvedValue({ sender: { id: "sender", channels: ["whatsapp"] } });
});

it("stores webhook secret before activating and connects only after confirmation", async () => {
  (ensureSenderChannelActive as jest.Mock).mockImplementation(async () => {
    expect(connection).toMatchObject({ status: "in_progress", metadata: { zavu_webhook_secret: "encrypted", activation_pending: true } });
    return { sender: { id: "sender", channels: ["whatsapp"] } };
  });
  await expect(activateChannelConnection("site", "channel")).resolves.toMatchObject({ connection: { status: "connected", metadata: { activation_pending: false, provider_channel_active: true } } });
  expect(requireActivationLicense).toHaveBeenCalledTimes(3);
});

it.each(["webhook", "activation"])("preserves recoverable pending state on %s failure", async (stage) => {
  const mock = stage === "webhook" ? ensureSenderWebhook : ensureSenderChannelActive;
  (mock as jest.Mock).mockRejectedValue(new Error("private provider detail"));
  await expect(activateChannelConnection("site", "channel")).rejects.toThrow("could not complete");
  expect(connection.status).toBe("in_progress");
  expect(connection.metadata.activation_pending).toBe(true);
  expect(connection.metadata.activation_error).not.toContain("private");
});

it.each([{ enabled: false }, { license_suspended: true }, { status: "disabled" }])("never activates disabled channel %j", async (patch) => {
  Object.assign(connection, patch);
  await expect(activateChannelConnection("site", "channel")).rejects.toMatchObject({ status: 409 });
  expect(ensureSenderChannelActive).not.toHaveBeenCalled();
  expect(patchActivationConnection).not.toHaveBeenCalled();
});

it("fails closed on projected license denial before provider changes", async () => {
  (requireActivationLicense as jest.Mock).mockRejectedValue(new Error("license unavailable"));
  await expect(activateChannelConnection("site", "channel")).rejects.toThrow("license unavailable");
  expect(ensureSenderWebhook).not.toHaveBeenCalled();
  expect(ensureSenderChannelActive).not.toHaveBeenCalled();
});

it("pins the authorized sender identity across the route-to-helper read", async () => {
  connection.zavu_sender_id = "replacement";
  await expect(activateChannelConnection("site", "channel", { senderId: "sender", type: "whatsapp" })).rejects.toMatchObject({ status: 409 });
  expect(ensureSenderChannelActive).not.toHaveBeenCalled();
});

it("does not release the occupied slot while verifying an established connection", async () => {
  connection.status = "connected";
  await activateChannelConnection("site", "channel", { senderId: "sender" });
  expect((patchActivationConnection as jest.Mock).mock.calls.every((call) => call[2].status !== "in_progress")).toBe(true);
});

it("does not claim success or overwrite disabled state after final CAS conflict", async () => {
  (patchActivationConnection as jest.Mock).mockImplementation(async (_site, _id, patch) => {
    if (patch.status === "connected") { connection.enabled = false; throw Object.assign(new Error("conflict"), { status: 409 }); }
    if (connection.enabled === false) throw Object.assign(new Error("conflict"), { status: 409 });
    return connection;
  });
  await expect(activateChannelConnection("site", "channel")).rejects.toMatchObject({ status: 409 });
  expect(connection.enabled).toBe(false);
});