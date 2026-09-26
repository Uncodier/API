import { NextRequest } from "next/server";
import { POST, PUT } from "../route";
import * as zavu from "@/lib/services/zavu";

jest.mock("@/lib/services/zavu", () => ({
  createSender: jest.fn(),
  updateSender: jest.fn(),
  attachSenderToAgent: jest.fn(),
  upsertChannelConnection: jest.fn(),
  ensureSenderWebhook: jest.fn(),
  getChannelConnection: jest.fn(),
  requireZavuSiteManager: jest.fn(),
}));

jest.mock("@/lib/utils/token-encryption", () => ({
  encryptToken: jest.fn((value) => `enc:${value}`),
}));

describe("POST /api/integrations/zavu/channels/email", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (zavu.requireZavuSiteManager as jest.Mock).mockResolvedValue(undefined);
    (zavu.getChannelConnection as jest.Mock).mockResolvedValue(null);
    (zavu.createSender as jest.Mock).mockResolvedValue({
      id: "snd_1",
      channels: [],
      webhook: {
        url: "https://backend.makinari.com/api/integrations/zavu/webhook",
        events: ["message.inbound"],
        active: true,
        secret: "whsec_1",
      },
    });
    (zavu.attachSenderToAgent as jest.Mock).mockResolvedValue(null);
    (zavu.upsertChannelConnection as jest.Mock).mockResolvedValue({
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
    (zavu.requireZavuSiteManager as jest.Mock).mockResolvedValue(undefined);
    (zavu.getChannelConnection as jest.Mock).mockResolvedValue({
      id: "channel_1",
      type: "email",
      zavu_sender_id: "snd_1",
    });
    (zavu.upsertChannelConnection as jest.Mock).mockResolvedValue({
      channelId: "channel_1",
    });
  });

  it("updates Zavu and persists only the remotely confirmed value", async () => {
    (zavu.updateSender as jest.Mock).mockResolvedValue({
      id: "snd_1",
      emailReceivingEnabled: true,
    });

    const response = await PUT(receivingRequest());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(zavu.requireZavuSiteManager).toHaveBeenCalledWith(expect.any(NextRequest), "site_1");
    expect(zavu.updateSender).toHaveBeenCalledWith("snd_1", {
      emailReceivingEnabled: true,
    });
    expect(zavu.upsertChannelConnection).toHaveBeenCalledWith(
      "site_1",
      "channel_1",
      { metadata: { emailReceivingEnabled: true } }
    );
    expect(payload.sender.emailReceivingEnabled).toBe(true);
  });

  it("returns and persists false when Zavu refuses receiving", async () => {
    (zavu.updateSender as jest.Mock).mockResolvedValue({
      id: "snd_1",
      emailReceivingEnabled: false,
    });

    const response = await PUT(receivingRequest());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(zavu.upsertChannelConnection).toHaveBeenCalledWith(
      "site_1",
      "channel_1",
      { metadata: { emailReceivingEnabled: false } }
    );
    expect(payload.sender.emailReceivingEnabled).toBe(false);
  });

  it("rejects non-boolean values before calling Zavu", async () => {
    const response = await PUT(receivingRequest("false"));

    expect(response.status).toBe(400);
    expect(zavu.updateSender).not.toHaveBeenCalled();
  });

  it("rejects a sender that does not belong to the channel", async () => {
    (zavu.getChannelConnection as jest.Mock).mockResolvedValue({
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
    (zavu.requireZavuSiteManager as jest.Mock).mockRejectedValue(error);

    const response = await PUT(receivingRequest());

    expect(response.status).toBe(403);
    expect(zavu.updateSender).not.toHaveBeenCalled();
  });
});
