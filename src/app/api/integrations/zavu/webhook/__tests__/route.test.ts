import { NextRequest } from "next/server";
import { POST } from "@/app/api/integrations/zavu/webhook/route";
import * as zavuService from "@/lib/services/zavu";
import * as webhookHandlers from "@/lib/services/zavu/webhook-handlers";

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

// Mock Next.js after() to immediately execute
jest.mock("next/server", () => {
  const original = jest.requireActual("next/server");
  return {
    ...original,
    after: jest.fn((cb) => cb()),
  };
});

describe("Zavu Webhook Dispatch", () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
});