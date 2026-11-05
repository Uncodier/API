import { NextRequest } from "next/server";
import { POST } from "../route";
import { activateChannelConnection } from "@/lib/services/zavu/connection-activation";
import { getChannelConnection } from "@/lib/services/zavu/persist";
import { requireZavuSiteManager } from "@/lib/services/zavu/site-access";

jest.mock("@/lib/services/zavu/connection-activation", () => ({ activateChannelConnection: jest.fn() }));
jest.mock("@/lib/services/zavu/persist", () => ({ getChannelConnection: jest.fn() }));
jest.mock("@/lib/services/zavu/site-access", () => ({ requireZavuSiteManager: jest.fn() }));
function request(body: unknown = { siteId: "site", channelId: "connection" }) {
  return new NextRequest("http://localhost/activate", { method: "POST", body: JSON.stringify(body) });
}
const params = (channel = "instagram") => ({ params: Promise.resolve({ id: "sender", channel }) });
beforeEach(() => {
  jest.resetAllMocks();
  (getChannelConnection as jest.Mock).mockResolvedValue({ type: "instagram", zavu_sender_id: "sender" });
  (activateChannelConnection as jest.Mock).mockResolvedValue({ activation: { activated: true }, connection: { status: "connected" } });
});

it.each(["instagram", "whatsapp", "messenger", "telegram", "email"])("activates an owned %s connection", async (channel) => {
  (getChannelConnection as jest.Mock).mockResolvedValue({ type: channel, zavu_sender_id: "sender" });
  const response = await POST(request(), params(channel));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ success: true, status: "connected", activationPending: false });
  expect(activateChannelConnection).toHaveBeenCalledWith("site", "connection", { senderId: "sender", type: channel });
});

it.each([401, 403])("rejects access before provider calls (%s)", async (status) => {
  (requireZavuSiteManager as jest.Mock).mockRejectedValue({ status });
  expect((await POST(request(), params())).status).toBe(status);
  expect(getChannelConnection).not.toHaveBeenCalled();
  expect(activateChannelConnection).not.toHaveBeenCalled();
});

it.each([null, { type: "telegram", zavu_sender_id: "sender" }, { type: "instagram", zavu_sender_id: "foreign" }])(
  "rejects missing/mismatched connection %j", async (connection) => {
    (getChannelConnection as jest.Mock).mockResolvedValue(connection);
    expect((await POST(request(), params())).status).toBe(connection ? 409 : 404);
    expect(activateChannelConnection).not.toHaveBeenCalled();
  },
);

it("rejects unsupported channels, client prices and malformed JSON", async () => {
  expect((await POST(request(), params("voice"))).status).toBe(400);
  expect((await POST(request({ siteId: "site", channelId: "connection", price: 0 }), params())).status).toBe(400);
  const malformed = new NextRequest("http://localhost/activate", { method: "POST", body: "{" });
  expect((await POST(malformed, params())).status).toBe(400);
  expect(activateChannelConnection).not.toHaveBeenCalled();
});

it("sanitizes provider failures", async () => {
  (activateChannelConnection as jest.Mock).mockRejectedValue({ status: 502, message: "provider secret" });
  const response = await POST(request(), params());
  expect(response.status).toBe(502);
  expect(JSON.stringify(await response.json())).not.toContain("provider secret");
});