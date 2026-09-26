import { NextRequest } from "next/server";
import { POST } from "../route";
import * as zavu from "@/lib/services/zavu";

jest.mock("@/lib/services/zavu", () => ({
  activateSenderChannel: jest.fn(),
  getChannelConnection: jest.fn(),
  requireZavuSiteManager: jest.fn(),
  upsertChannelConnection: jest.fn(),
}));

function activationRequest() {
  return new NextRequest(
    "http://localhost/api/integrations/zavu/senders/snd_1/channels/email/activate",
    {
      method: "POST",
      body: JSON.stringify({
        siteId: "site_1",
        channelId: "channel_1",
      }),
    }
  );
}

describe("POST /api/integrations/zavu/senders/:id/channels/email/activate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (zavu.requireZavuSiteManager as jest.Mock).mockResolvedValue(undefined);
    (zavu.getChannelConnection as jest.Mock).mockResolvedValue({
      id: "channel_1",
      zavu_sender_id: "snd_1",
    });
    (zavu.upsertChannelConnection as jest.Mock).mockResolvedValue({
      channelId: "channel_1",
    });
  });

  it("activates email and persists the connected state", async () => {
    (zavu.activateSenderChannel as jest.Mock).mockResolvedValue({
      sender: { id: "snd_1", channels: ["email"] },
      channel: "email",
      activated: true,
      chargedCents: 0,
      monthlyCents: 0,
    });

    const response = await POST(activationRequest(), {
      params: Promise.resolve({ id: "snd_1" }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(zavu.activateSenderChannel).toHaveBeenCalledWith("snd_1", "email");
    expect(zavu.upsertChannelConnection).toHaveBeenCalledWith(
      "site_1",
      "channel_1",
      {
        status: "connected",
        metadata: { emailChannelActive: true },
      }
    );
    expect(payload).toEqual(expect.objectContaining({
      success: true,
      activated: true,
      channel: "email",
    }));
  });

  it("rejects a sender that does not belong to the channel connection", async () => {
    (zavu.getChannelConnection as jest.Mock).mockResolvedValue({
      id: "channel_1",
      zavu_sender_id: "snd_other",
    });

    const response = await POST(activationRequest(), {
      params: Promise.resolve({ id: "snd_1" }),
    });

    expect(response.status).toBe(409);
    expect(zavu.activateSenderChannel).not.toHaveBeenCalled();
  });
});
