import { NextRequest } from "next/server";
import { POST } from "../route";
import * as zavu from "@/lib/services/zavu";

jest.mock("@/lib/services/zavu", () => ({
  createSender: jest.fn(),
  connectTelegram: jest.fn(),
  attachSenderToAgent: jest.fn(),
  upsertChannelConnection: jest.fn(),
  ensureSenderWebhook: jest.fn(),
  getChannelConnection: jest.fn(),
}));

jest.mock("@/lib/utils/token-encryption", () => ({
  encryptToken: jest.fn((value) => `enc:${value}`),
}));

describe("POST /api/integrations/zavu/channels/telegram", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (zavu.connectTelegram as jest.Mock).mockResolvedValue({ telegram: { botUsername: "bot" } });
    (zavu.attachSenderToAgent as jest.Mock).mockResolvedValue(null);
    (zavu.upsertChannelConnection as jest.Mock).mockResolvedValue({ channelId: "ch_1" });
  });

  it("reuses zavu_sender_id when the front resends channelId", async () => {
    (zavu.getChannelConnection as jest.Mock).mockResolvedValue({
      id: "ch_1",
      zavu_sender_id: "snd_existing",
    });
    (zavu.ensureSenderWebhook as jest.Mock).mockResolvedValue({
      id: "snd_existing",
      webhook: { url: "https://backend.makinari.com/api/integrations/zavu/webhook", events: ["message.inbound"], active: true },
    });

    const req = new NextRequest("http://localhost/api/integrations/zavu/channels/telegram", {
      method: "POST",
      body: JSON.stringify({
        siteId: "site-1",
        channelId: "ch_1",
        botToken: "token",
        name: "Telegram",
      }),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(zavu.createSender).not.toHaveBeenCalled();
    expect(zavu.ensureSenderWebhook).toHaveBeenCalledWith("snd_existing");
    expect(zavu.connectTelegram).toHaveBeenCalledWith("snd_existing", "token");
    expect(zavu.upsertChannelConnection).toHaveBeenCalledWith(
      "site-1",
      "ch_1",
      expect.objectContaining({ zavu_sender_id: "snd_existing" })
    );
    expect(json.senderId).toBe("snd_existing");
  });

  it("creates a sender when no existing zavu_sender_id is stored", async () => {
    (zavu.getChannelConnection as jest.Mock).mockResolvedValue(null);
    (zavu.createSender as jest.Mock).mockResolvedValue({
      id: "snd_new",
      webhook: { events: ["message.inbound"], secret: "whsec", active: true, url: "https://x/webhook" },
    });

    const req = new NextRequest("http://localhost/api/integrations/zavu/channels/telegram", {
      method: "POST",
      body: JSON.stringify({
        siteId: "site-1",
        botToken: "token",
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
