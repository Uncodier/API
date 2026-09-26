import { NextRequest } from "next/server";
import { jest } from "@jest/globals";

const mockFunction = () => jest.fn<(...args: any[]) => any>();
const zavu = {
  activateSenderChannel: mockFunction(),
  getChannelConnection: mockFunction(),
  requireZavuSiteManager: mockFunction(),
  upsertChannelConnection: mockFunction(),
};

jest.unstable_mockModule("@/lib/services/zavu", () => zavu);

let POST: typeof import("../route").POST;

beforeAll(async () => {
  ({ POST } = await import("../route"));
});

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
    zavu.requireZavuSiteManager.mockResolvedValue(undefined);
    zavu.getChannelConnection.mockResolvedValue({
      id: "channel_1",
      type: "email",
      zavu_sender_id: "snd_1",
    });
    zavu.upsertChannelConnection.mockResolvedValue({
      channelId: "channel_1",
    });
  });

  it("activates email and persists the connected state", async () => {
    zavu.activateSenderChannel.mockResolvedValue({
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
    zavu.getChannelConnection.mockResolvedValue({
      id: "channel_1",
      type: "email",
      zavu_sender_id: "snd_other",
    });

    const response = await POST(activationRequest(), {
      params: Promise.resolve({ id: "snd_1" }),
    });

    expect(response.status).toBe(409);
    expect(zavu.activateSenderChannel).not.toHaveBeenCalled();
  });

  it("rejects a non-email connection", async () => {
    zavu.getChannelConnection.mockResolvedValue({
      id: "channel_1",
      type: "voice",
      zavu_sender_id: "snd_1",
    });

    const response = await POST(activationRequest(), {
      params: Promise.resolve({ id: "snd_1" }),
    });

    expect(response.status).toBe(409);
    expect(zavu.activateSenderChannel).not.toHaveBeenCalled();
  });

  it("does not persist activation returned for a different sender", async () => {
    zavu.activateSenderChannel.mockResolvedValue({
      sender: { id: "snd_other", channels: ["email"] },
      activated: true,
    });

    const response = await POST(activationRequest(), {
      params: Promise.resolve({ id: "snd_1" }),
    });

    expect(response.status).toBe(502);
    expect(zavu.upsertChannelConnection).not.toHaveBeenCalled();
  });
});
