import { NextRequest } from "next/server";
import { POST } from "../route";
import { createPartnerInvitation, requireZavuSiteManager, getChannelConnection } from "@/lib/services/zavu";
import { supabaseAdmin } from "@/lib/database/supabase-server";

jest.mock("@/lib/services/zavu", () => ({
  createPartnerInvitation: jest.fn(), requireZavuSiteManager: jest.fn(), getChannelConnection: jest.fn(),
  ensureProjectWebhook: jest.fn(),
  isChannelActivationBlocked: (connection: any) => connection?.enabled === false,
}));
jest.mock("@/lib/database/supabase-server", () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock("@/lib/services/zavu/activation-persistence", () => ({ patchActivationConnection: jest.fn() }));
jest.mock("@/lib/services/site-configuration-cache", () => ({ refreshSiteConfigurationCaches: jest.fn() }));
jest.mock("uuid", () => ({ v4: () => "channel" }));

const request = (body: any = { siteId: "site", connectionType: "whatsapp_waba" }) =>
  new NextRequest("http://localhost/invitations", { method: "POST", body: JSON.stringify(body) });
beforeEach(() => {
  jest.resetAllMocks();
  (createPartnerInvitation as jest.Mock).mockResolvedValue({ id: "inv_1", url: "https://example.test/invite" });
  const query = {
    select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), update: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: { id: "settings", channels: { connections: [] } } }),
    then: (resolve: any) => Promise.resolve({ error: null }).then(resolve),
  };
  (supabaseAdmin.from as jest.Mock).mockReturnValue(query);
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

it.each(["whatsapp_waba", "messenger"])("creates a supported %s invitation after manager authorization", async (connectionType) => {
  const response = await POST(request({ siteId: "site", connectionType }));
  expect(response.status).toBe(200);
  expect(requireZavuSiteManager).toHaveBeenCalled();
  expect(createPartnerInvitation).toHaveBeenCalledWith(expect.objectContaining({ connectionType }));
});
it.each([401, 403])("denies creation before provider writes (%s)", async (status) => {
  (requireZavuSiteManager as jest.Mock).mockRejectedValue({ status });
  expect((await POST(request())).status).toBe(status);
  expect(createPartnerInvitation).not.toHaveBeenCalled();
});
it("rejects unsupported Instagram invitations rather than routing to Messenger", async () => {
  expect((await POST(request({ siteId: "site", connectionType: "instagram" }))).status).toBe(400);
  expect(createPartnerInvitation).not.toHaveBeenCalled();
});
it.each([{ type: "email" }, { type: "whatsapp", enabled: false }, { type: "whatsapp", zavu_sender_id: "sender" }])(
  "does not overwrite existing connections %j", async (existing) => {
    (getChannelConnection as jest.Mock).mockResolvedValue(existing);
    expect((await POST(request({ siteId: "site", channelId: "channel", connectionType: "whatsapp_waba" }))).status).toBe(409);
    expect(createPartnerInvitation).not.toHaveBeenCalled();
  },
);