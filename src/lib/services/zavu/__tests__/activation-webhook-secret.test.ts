import { randomUUID } from "node:crypto";
import { prepareActivationWebhookSecret } from "../activation-webhook-secret";
import { claimProviderWebhookEvent, finishProviderWebhookEvent } from "@/lib/services/provider-webhook-claims";
import { getChannelConnection } from "../persist";
import { patchActivationConnection } from "../activation-persistence";
import { zavuFetch } from "../client";

jest.mock("@/lib/services/provider-webhook-claims", () => ({ claimProviderWebhookEvent: jest.fn(), finishProviderWebhookEvent: jest.fn() }));
jest.mock("../persist", () => ({ getChannelConnection: jest.fn() }));
jest.mock("../activation-persistence", () => ({ patchActivationConnection: jest.fn() }));
jest.mock("../client", () => ({ zavuFetch: jest.fn() }));
jest.mock("@/lib/utils/token-encryption", () => ({ encryptToken: (value: string) => `encrypted:${value}` }));
const expected = { senderId: "sender", type: "whatsapp" };
let connection: any;
beforeEach(() => {
  jest.resetAllMocks();
  connection = { zavu_sender_id: "sender", metadata: {} };
  (getChannelConnection as jest.Mock).mockImplementation(async () => connection);
  (claimProviderWebhookEvent as jest.Mock).mockResolvedValue({ state: "claimed", token: "lease", expiresAt: new Date(Date.now() + 300000).toISOString() });
  (finishProviderWebhookEvent as jest.Mock).mockResolvedValue(true);
  (patchActivationConnection as jest.Mock).mockImplementation(async (_site, _id, patch) => { connection.metadata = { ...connection.metadata, ...patch.metadata }; });
});
it("serializes concurrent webhook and polling secret initialization", async () => {
  let release!: (value: any) => void;
  const secret = randomUUID();
  (zavuFetch as jest.Mock).mockImplementation(() => new Promise((resolve) => { release = resolve; }));
  (claimProviderWebhookEvent as jest.Mock).mockResolvedValueOnce({ state: "claimed", token: "lease", expiresAt: new Date(Date.now() + 300000).toISOString() }).mockResolvedValueOnce({ state: "busy" });
  const first = prepareActivationWebhookSecret("site", "channel", expected);
  while (!release) await Promise.resolve();
  await expect(prepareActivationWebhookSecret("site", "channel", expected)).rejects.toThrow("in progress");
  release({ secret });
  await first;
  expect(zavuFetch).toHaveBeenCalledTimes(1);
  expect(connection.metadata.zavu_webhook_secret).toBe(`encrypted:${secret}`);
  await prepareActivationWebhookSecret("site", "channel", expected);
  expect(zavuFetch).toHaveBeenCalledTimes(1);
});
it("stores a one-time returned secret without rotation", async () => {
  const secret = randomUUID();
  await prepareActivationWebhookSecret("site", "channel", expected, secret);
  expect(zavuFetch).not.toHaveBeenCalled();
  expect(connection.metadata.zavu_webhook_secret).toBe(`encrypted:${secret}`);
});
it("does not rotate again when completed initialization lost its database secret", async () => {
  (claimProviderWebhookEvent as jest.Mock).mockResolvedValue({ state: "completed" });
  await expect(prepareActivationWebhookSecret("site", "channel", expected)).rejects.toThrow("reconciliation");
  expect(zavuFetch).not.toHaveBeenCalled();
});
it("holds ambiguous rotation for reconciliation rather than automatically rotating again", async () => {
  (zavuFetch as jest.Mock).mockRejectedValue(new Error("private provider detail"));
  await expect(prepareActivationWebhookSecret("site", "channel", expected)).rejects.toThrow("Could not initialize");
  expect(finishProviderWebhookEvent).not.toHaveBeenCalled();
  expect(connection.metadata.webhook_rotation_uncertain).toBe(true);
  await expect(prepareActivationWebhookSecret("site", "channel", expected)).rejects.toThrow("Could not initialize");
  expect(zavuFetch).toHaveBeenCalledTimes(1);
});