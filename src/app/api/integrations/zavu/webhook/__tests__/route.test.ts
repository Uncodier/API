import { NextRequest } from "next/server";
import { POST } from "@/app/api/integrations/zavu/webhook/route";
import * as zavuService from "@/lib/services/zavu";
import * as webhookHandlers from "@/lib/services/zavu/webhook-handlers";
import * as webhookClaims from "@/lib/services/provider-webhook-claims";

// Mock the imports
jest.mock("@/lib/services/zavu", () => ({
  verifyZavuSignature: jest.fn().mockReturnValue(true),
}));

jest.mock("@/lib/services/zavu/webhook-handlers", () => ({
  findSettingsForSender: jest.fn().mockResolvedValue([]),
  handleInboundMessage: jest.fn().mockResolvedValue(undefined),
  handleInvitationStatusChanged: jest.fn().mockResolvedValue(undefined),
  handleDomainStatusChanged: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/services/provider-webhook-claims", () => ({
  claimProviderWebhookEvent: jest.fn(),
  finishProviderWebhookEvent: jest.fn(),
}));

// Mock process.env
const originalEnv = process.env;
beforeAll(() => {
  process.env = {
    ...originalEnv,
    ZAVUDEV_WEBHOOK_SECRET: "test-secret",
  };
});

afterAll(() => {
  process.env = originalEnv;
});

describe("Zavu Webhook Dispatch", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (webhookClaims.claimProviderWebhookEvent as jest.Mock).mockResolvedValue({
      state: "claimed",
      token: "claim-token",
      expiresAt: "2026-09-20T08:00:00.000Z",
    });
    (webhookClaims.finishProviderWebhookEvent as jest.Mock)
      .mockResolvedValue(true);
  });

  const createRequest = (body: any) => {
    return new NextRequest("http://localhost:3000/api/integrations/zavu/webhook", {
      method: "POST",
      headers: {
        "x-zavu-signature": "v2=fake_signature",
      },
      body: JSON.stringify(body),
    });
  };

  it("should dispatch message.inbound to handleInboundMessage", async () => {
    const payload = {
      type: "message.inbound",
      senderId: "snd_123",
      data: {
        channel: "telegram",
        from: "user123",
        text: "hello",
      },
    };

    const req = createRequest(payload);
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(webhookHandlers.handleInboundMessage).toHaveBeenCalledTimes(1);
    expect(webhookHandlers.handleInboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "message.inbound" })
    );
    expect(webhookClaims.finishProviderWebhookEvent).toHaveBeenCalledWith(
      "zavu",
      expect.any(String),
      "claim-token",
      "completed",
    );
  });

  it("should dispatch domain.verified to handleDomainStatusChanged", async () => {
    const payload = {
      type: "domain.verified",
      data: {
        domainId: "dom_123",
      },
    };

    const req = createRequest(payload);
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(webhookHandlers.handleDomainStatusChanged).toHaveBeenCalledTimes(1);
    expect(webhookHandlers.handleDomainStatusChanged).toHaveBeenCalledWith(
      expect.objectContaining({ domainId: "dom_123" }),
      "domain.verified"
    );
  });

  it("should dispatch invitation.status_changed to handleInvitationStatusChanged", async () => {
    const payload = {
      type: "invitation.status_changed",
      data: {
        invitationId: "inv_123",
        currentStatus: "completed",
      },
    };

    const req = createRequest(payload);
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(webhookHandlers.handleInvitationStatusChanged).toHaveBeenCalledTimes(1);
    expect(webhookHandlers.handleInvitationStatusChanged).toHaveBeenCalledWith(
      expect.objectContaining({ invitationId: "inv_123" })
    );
  });

  it("should ignore conversation.new and log without throwing", async () => {
    const payload = {
      type: "conversation.new",
      data: {
        conversationId: "conv_123",
      },
    };

    const req = createRequest(payload);
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(webhookHandlers.handleInboundMessage).not.toHaveBeenCalled();
  });
  
  it("should ignore delivery events and log without throwing", async () => {
    const payload = {
      type: "message.delivered",
      data: {
        messageId: "msg_123",
      },
    };

    const req = createRequest(payload);
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(webhookHandlers.handleInboundMessage).not.toHaveBeenCalled();
  });

  it("records a failed claim and requests a retry on processing errors", async () => {
    (webhookHandlers.handleInboundMessage as jest.Mock)
      .mockRejectedValueOnce(new Error("database unavailable"));
    const req = createRequest({
      id: "evt_failed",
      type: "message.inbound",
      senderId: "snd_123",
      data: {
        channel: "telegram",
        from: "user123",
        text: "hello",
      },
    });

    const res = await POST(req);

    expect(res.status).toBe(500);
    expect(webhookClaims.finishProviderWebhookEvent).toHaveBeenCalledWith(
      "zavu",
      "evt_failed",
      "claim-token",
      "failed",
      "database unavailable",
    );
  });
});