import { NextRequest } from "next/server";
import { POST } from "../route";
import * as zavu from "@/lib/services/zavu";

jest.mock("@/lib/services/zavu", () => ({
  createSender: jest.fn(),
  updateSender: jest.fn(),
  attachSenderToAgent: jest.fn(),
  upsertChannelConnection: jest.fn(),
  ensureSenderWebhook: jest.fn(),
  getChannelConnection: jest.fn(),
}));

jest.mock("@/lib/utils/token-encryption", () => ({
  encryptToken: jest.fn((value) => `enc:${value}`),
}));

describe("POST /api/integrations/zavu/channels/email", () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
