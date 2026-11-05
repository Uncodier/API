import { randomBytes } from "node:crypto";
import { createSender, ZAVU_SENDER_MESSAGE_WEBHOOK_EVENTS } from "../client";

const originalFetch = global.fetch;
const originalKey = process.env.ZAVUDEV_API_KEY;
const response = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body),
}) as Response;

beforeEach(() => {
  process.env.ZAVUDEV_API_KEY = randomBytes(24).toString("hex");
  global.fetch = jest.fn();
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  global.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.ZAVUDEV_API_KEY;
  else process.env.ZAVUDEV_API_KEY = originalKey;
  jest.restoreAllMocks();
});

it("persists the created sender and one-time secret before webhook failure", async () => {
  const secret = randomBytes(24).toString("hex");
  const created = { id: "sender", webhook: { secret, events: [] } };
  const onCreated = jest.fn(async (sender) => { expect(sender).toEqual(created); });
  (global.fetch as jest.Mock)
    .mockResolvedValueOnce(response(201, { sender: created }))
    .mockImplementationOnce(async () => {
      expect(onCreated).toHaveBeenCalledTimes(1);
      return response(503, { error: "Webhook unavailable" });
    });
  await expect(createSender({ name: "Example" }, { onCreated })).rejects.toThrow("Webhook unavailable");
  expect(onCreated).toHaveBeenCalledWith(created);
});

it("awaits identity persistence and stops setup when persistence fails", async () => {
  (global.fetch as jest.Mock).mockResolvedValue(response(201, { id: "sender" }));
  const onCreated = jest.fn(async () => { throw new Error("database unavailable"); });
  await expect(createSender({ name: "Example" }, { onCreated })).rejects.toThrow("database unavailable");
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

it("keeps the webhook confirmation contract and never sends callbacks to Zavu", async () => {
  const onCreated = jest.fn(async () => {});
  (global.fetch as jest.Mock).mockResolvedValueOnce(response(201, { id: "sender" }))
    .mockResolvedValueOnce(response(200, { id: "sender", webhook: { events: ZAVU_SENDER_MESSAGE_WEBHOOK_EVENTS } }));
  await expect(createSender({ name: "Example" }, { onCreated })).resolves.toMatchObject({ id: "sender" });
  const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
  expect(body).not.toHaveProperty("onCreated");
  expect(onCreated).toHaveBeenCalledTimes(1);
});