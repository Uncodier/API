import crypto from "crypto";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/integrations/zavu/webhook/route";
import { reconcileTemplateDeliveryEvent } from '@/lib/services/zavu/template-delivery-events';
import { reconcileAudioDeliveryEvent } from '@/lib/services/zavu/audio-delivery-events';
jest.mock('@/lib/services/zavu/audio-delivery-events', () => ({ reconcileAudioDeliveryEvent: jest.fn() }));
jest.mock('@/lib/services/zavu/template-delivery-events', () => ({ reconcileTemplateDeliveryEvent: jest.fn() }));
import * as webhookHandlers from "@/lib/services/zavu/webhook-handlers";
import * as webhookClaims from "@/lib/services/provider-webhook-claims";
import { handleWhatsAppAppEcho } from '@/lib/services/zavu/whatsapp-app-echo';
jest.mock('@/lib/services/zavu/whatsapp-app-echo', () => ({
  isWhatsAppAppEcho: jest.requireActual('@/lib/services/zavu/whatsapp-app-echo').isWhatsAppAppEcho,
  handleWhatsAppAppEcho: jest.fn(),
}));

jest.mock("@/lib/services/zavu", () => ({
  verifyZavuSignature: jest.requireActual(
    "@/lib/services/zavu/signature"
  ).verifyZavuSignature,
}));

jest.mock("@/lib/services/zavu/webhook-handlers", () => ({
  findSettingsForSender: jest.fn().mockResolvedValue([]),
  handleInboundMessage: jest.fn().mockResolvedValue(undefined),
  handleInvitationStatusChanged: jest.fn().mockResolvedValue(undefined),
  handleDomainStatusChanged: jest.fn().mockResolvedValue(undefined),
  handleVoiceCallEvent: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/lib/utils/token-decryption", () => ({
  decryptToken: (value: string) => value.replace("encrypted:", ""),
}));

jest.mock("@/lib/services/provider-webhook-claims", () => ({
  claimProviderWebhookEvent: jest.fn(),
  finishProviderWebhookEvent: jest.fn(),
}));

// Mock process.env
const originalEnv = process.env;
const projectSecret = crypto.randomBytes(32).toString('hex');
const senderSecret = crypto.randomBytes(32).toString('hex');
beforeAll(() => {
  process.env = {
    ...originalEnv,
    ZAVUDEV_WEBHOOK_SECRET: projectSecret,
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

  const createRequest = (body: any, secret = projectSecret) => {
    const rawBody = JSON.stringify(body);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto
      .createHmac("sha256", secret)
      .update(`${timestamp}.${rawBody}`)
      .digest("hex");

    return new NextRequest("http://localhost:3000/api/integrations/zavu/webhook", {
      method: "POST",
      headers: {
        "x-zavu-signature": `t=${timestamp},v2=${signature}`,
      },
      body: rawBody,
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

  it("dispatches Voice lifecycle events to handleVoiceCallEvent", async () => {
    const payload = {
      id: "evt_call_1",
      type: "call.completed",
      senderId: "snd_123",
      data: {
        callId: "call_123",
        status: "completed",
        transcriptAvailable: true,
      },
    };

    const res = await POST(createRequest(payload));

    expect(res.status).toBe(200);
    expect(webhookHandlers.handleVoiceCallEvent).toHaveBeenCalledWith(payload);
  });

  it("uses a secret-bearing connection when a sender has multiple channels", async () => {
    (webhookHandlers.findSettingsForSender as jest.Mock).mockResolvedValueOnce([{
      channels: {
        connections: [
          { type: "voice", zavu_sender_id: "snd_123", metadata: {} },
          {
            type: "sms",
            zavu_sender_id: "snd_123",
            metadata: { zavu_webhook_secret: `encrypted:${senderSecret}` },
          },
        ],
      },
    }]);
    const payload = {
      id: "evt_shared_sender",
      type: "call.completed",
      senderId: "snd_123",
      data: { callId: "call_123" },
    };

    const response = await POST(createRequest(payload, senderSecret));

    expect(response.status).toBe(200);
    expect(webhookHandlers.handleVoiceCallEvent).toHaveBeenCalledWith(payload);
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
  
  it("dispatches delivery events to template reconciliation", async () => {
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
    expect(reconcileTemplateDeliveryEvent).toHaveBeenCalledWith(payload);
    expect(reconcileAudioDeliveryEvent).toHaveBeenCalledWith(payload);
  });

  it('does not deduplicate distinct delivery transitions by the same message ID', async () => {
    await POST(createRequest({ type: 'message.sent', senderId: 'sender', data: { messageId: 'provider', channel: 'whatsapp' } }));
    await POST(createRequest({ type: 'message.failed', senderId: 'sender', data: { messageId: 'provider', channel: 'whatsapp' } }));
    expect(webhookClaims.claimProviderWebhookEvent).toHaveBeenCalledWith('zavu', 'message.sent:provider', 'message.sent');
    expect(webhookClaims.claimProviderWebhookEvent).toHaveBeenCalledWith('zavu', 'message.failed:provider', 'message.failed');
    expect(reconcileTemplateDeliveryEvent).toHaveBeenCalledTimes(2);
    expect(reconcileAudioDeliveryEvent).toHaveBeenCalledTimes(2);
  });

  it('dispatches signed app echoes before delivery reconciliation', async () => {
    const payload = { id: 'echo-event', type: 'message.sent', senderId: 'sender',
      data: { source: 'whatsapp_business_app', channel: 'whatsapp', direction: 'outbound', messageId: 'provider' } };
    expect((await POST(createRequest(payload))).status).toBe(200);
    expect(handleWhatsAppAppEcho).toHaveBeenCalledWith(payload);
    expect(reconcileTemplateDeliveryEvent).not.toHaveBeenCalled();
    expect(reconcileAudioDeliveryEvent).not.toHaveBeenCalled();
    expect(webhookHandlers.handleInboundMessage).not.toHaveBeenCalled();
  });

  it('rejects unsigned echoes before claims and persistence', async () => {
    const request = createRequest({ type: 'message.sent', data: { source: 'whatsapp_business_app' } });
    request.headers.delete('x-zavu-signature');
    expect((await POST(request)).status).toBe(401);
    expect(handleWhatsAppAppEcho).not.toHaveBeenCalled();
    expect(webhookClaims.claimProviderWebhookEvent).not.toHaveBeenCalled();
  });

  it('asks the provider to retry a delivery event if its saved receipt is not yet available', async () => {
    jest.mocked(reconcileTemplateDeliveryEvent).mockRejectedValueOnce(new Error('receipt not ready'));
    const response = await POST(createRequest({ id: 'evt-delivery', type: 'message.failed', senderId: 'sender',
      data: { messageId: 'provider', channel: 'whatsapp' } }));
    expect(response.status).toBe(500);
    expect(webhookClaims.finishProviderWebhookEvent).toHaveBeenCalledWith('zavu', 'evt-delivery', 'claim-token', 'failed', 'receipt not ready');
  });
  it('fails the durable claim for an early audio callback so the provider can retry without resending', async () => {
    jest.mocked(reconcileAudioDeliveryEvent).mockRejectedValueOnce(new Error('audio receipt not ready'));
    expect((await POST(createRequest({ id: 'evt-audio', type: 'message.delivered', senderId: 'sender',
      data: { messageId: 'provider', channel: 'telegram', to: 'recipient' } }))).status).toBe(500);
    expect(webhookClaims.finishProviderWebhookEvent).toHaveBeenCalledWith('zavu', 'evt-audio', 'claim-token', 'failed', 'audio receipt not ready');
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