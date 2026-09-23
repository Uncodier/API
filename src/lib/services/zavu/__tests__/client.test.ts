import {
  activateSenderChannel,
  assignPhoneNumberToSender,
  attachSenderToAgent,
  createSender,
  createVoiceSender,
  deleteSender,
  ensureProjectWebhook,
  ensureSenderWebhook,
  ensureVoiceSender,
  regenerateSenderWebhookSecret,
  ZAVU_PROJECT_WEBHOOK_EVENTS,
  ZAVU_SENDER_WEBHOOK_EVENTS,
  sendChannelMessage,
} from "../client";
import {
  createStandaloneAgent,
  getSenderAgent,
  listAgentVoices,
  upsertAgentTool,
} from "../agent-client";
import { getVoiceCall, hangupVoiceCall, placeVoiceCall } from "../voice-call-client";

function mockJson(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("Zavu client webhook contract", () => {
  const originalFetch = global.fetch;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      ZAVUDEV_API_KEY: "test-key",
      API_SERVER_URL: "https://backend.makinari.com",
    };
    global.fetch = jest.fn();
  });

  it("subscribes sender webhooks to the complete Voice call lifecycle", () => {
    expect(ZAVU_SENDER_WEBHOOK_EVENTS).toEqual(expect.arrayContaining([
      "call.initiated",
      "call.answered",
      "call.completed",
      "call.failed",
    ]));
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
  });

  it("createSender posts webhook events and always PATCHes to ensure them", async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(
        mockJson(201, {
          sender: {
            id: "snd_1",
            webhook: { url: "https://backend.makinari.com/api/integrations/zavu/webhook", events: [], secret: "whsec_create" },
          },
        })
      )
      .mockResolvedValueOnce(
        mockJson(200, {
          sender: {
            id: "snd_1",
            webhook: {
              url: "https://backend.makinari.com/api/integrations/zavu/webhook",
              events: ZAVU_SENDER_WEBHOOK_EVENTS,
              active: true,
            },
          },
        })
      );

    const sender = await createSender({ name: "Telegram site-1", enableSmsOneway: true });

    expect(sender.id).toBe("snd_1");
    expect(sender.webhook.secret).toBe("whsec_create");
    expect(sender.webhook.events).toEqual(ZAVU_SENDER_WEBHOOK_EVENTS);

    const createBody = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(createBody.webhookEvents).toEqual(ZAVU_SENDER_WEBHOOK_EVENTS);
    expect(createBody.webhookUrl).toBe("https://backend.makinari.com/api/integrations/zavu/webhook");

    const patchBody = JSON.parse((global.fetch as jest.Mock).mock.calls[1][1].body);
    expect((global.fetch as jest.Mock).mock.calls[1][0]).toBe("https://api.zavu.dev/v1/senders/snd_1");
    expect(patchBody.webhookEvents).toEqual(ZAVU_SENDER_WEBHOOK_EVENTS);
    expect(patchBody.webhookActive).toBe(true);
  });

  it("createSender fails if webhook events stay empty after PATCH", async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(mockJson(201, { id: "snd_2", webhook: { events: [] } }))
      .mockResolvedValueOnce(mockJson(200, { id: "snd_2", webhook: { events: [] } }));

    await expect(createSender({ name: "Broken" })).rejects.toThrow(
      "Zavu sender webhook events were not persisted"
    );
  });

  it("ensureSenderWebhook PATCHes the sender event list", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      mockJson(200, { id: "snd_3", webhook: { events: ["message.inbound"], active: true } })
    );

    const sender = await ensureSenderWebhook("snd_3");
    expect(sender.id).toBe("snd_3");
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.webhookEvents).toEqual(ZAVU_SENDER_WEBHOOK_EVENTS);
  });

  it("regenerates and returns a sender webhook secret", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      mockJson(200, { secret: "whsec_regenerated" })
    );

    await expect(
      regenerateSenderWebhookSecret("snd/voice")
    ).resolves.toBe("whsec_regenerated");
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.zavu.dev/v1/senders/snd%2Fvoice/webhook/secret",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("enables Voice and verifies the sender channel", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      mockJson(200, {
        sender: {
          id: "snd_voice",
          channels: ["voice"],
          webhook: { events: ZAVU_SENDER_WEBHOOK_EVENTS, active: true },
        },
      })
    );

    await expect(ensureVoiceSender("snd/voice")).resolves.toMatchObject({
      id: "snd_voice",
      channels: ["voice"],
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.zavu.dev/v1/senders/snd%2Fvoice",
      expect.objectContaining({ method: "PATCH" })
    );
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.enableVoice).toBe(true);
    expect(body).not.toHaveProperty("enableSmsOneway");
    expect(body.webhookEvents).toEqual(ZAVU_SENDER_WEBHOOK_EVENTS);
  });

  it("creates a staged sender with its phone number and Voice disabled", async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(
        mockJson(201, {
          sender: {
            id: "snd_voice",
            channels: [],
            webhook: {
              events: ZAVU_SENDER_WEBHOOK_EVENTS,
              secret: "whsec_sender",
            },
          },
        })
      )
      .mockResolvedValueOnce(
        mockJson(200, {
          sender: {
            id: "snd_voice",
            channels: [],
            webhook: { events: ZAVU_SENDER_WEBHOOK_EVENTS },
          },
        })
      );

    await createVoiceSender({
      name: "Voice Support",
      phoneNumber: "+14155550100",
    });

    const createBody = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(createBody.phoneNumber).toBe("+14155550100");
    expect(createBody).not.toHaveProperty("enableVoice");
  });

  it("assigns an owned phone number by its authoritative ID", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(mockJson(200, {
      id: "phone_1",
      senderId: "sender_1",
    }));

    await assignPhoneNumberToSender("phone/1", "sender_1");

    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.zavu.dev/v1/phone-numbers/phone%2F1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ senderId: "sender_1" }),
      })
    );
  });

  it("ensureProjectWebhook PATCHes when a webhook already exists", async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(mockJson(200, { webhook: { url: "https://old.example/hook", events: [], active: true } }))
      .mockResolvedValueOnce(mockJson(200, { webhook: { url: "https://backend.makinari.com/api/integrations/zavu/webhook" } }));

    await ensureProjectWebhook();

    expect((global.fetch as jest.Mock).mock.calls[0][1].method).toBeUndefined();
    expect((global.fetch as jest.Mock).mock.calls[1][1].method).toBe("PATCH");
    const patchBody = JSON.parse((global.fetch as jest.Mock).mock.calls[1][1].body);
    expect(patchBody.events).toEqual(ZAVU_PROJECT_WEBHOOK_EVENTS);
  });

  it("ensureProjectWebhook POSTs when GET returns 404", async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(mockJson(404, { message: "Not Found" }))
      .mockResolvedValueOnce(mockJson(201, { webhook: { secret: "whsec_project" } }));

    await ensureProjectWebhook();

    expect((global.fetch as jest.Mock).mock.calls[1][1].method).toBe("POST");
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[1][1].body);
    expect(body.events).toEqual(ZAVU_PROJECT_WEBHOOK_EVENTS);
  });

  describe("sendChannelMessage", () => {
    it("sends text message correctly", async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        mockJson(200, { message: { id: "msg_123" } })
      );

      await sendChannelMessage({
        to: "12345",
        text: "Hello",
        channel: "telegram"
      });

      expect(global.fetch).toHaveBeenCalledWith(
        "https://api.zavu.dev/v1/messages",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            to: "12345",
            text: "Hello",
            channel: "telegram"
          })
        })
      );
    });

    it("sends media message correctly", async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        mockJson(200, { message: { id: "msg_124" } })
      );

      await sendChannelMessage({
        to: "12345",
        channel: "whatsapp",
        messageType: "audio",
        content: { mediaUrl: "https://audio.mp3" }
      });

      expect(global.fetch).toHaveBeenCalledWith(
        "https://api.zavu.dev/v1/messages",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            to: "12345",
            channel: "whatsapp",
            messageType: "audio",
            content: { mediaUrl: "https://audio.mp3" }
          })
        })
      );
    });
  });

  describe("voice calls", () => {
    it("places a conversational call with per-call overrides", async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        mockJson(202, {
          call: {
            id: "call_123",
            direction: "outbound",
            from: "+14155550100",
            to: "+5215551234567",
            status: "queued",
            createdAt: "2026-09-21T00:00:00.000Z",
          },
        })
      );

      await placeVoiceCall({
        to: "+5215551234567",
        senderId: "sender_1",
        greeting: "Hello from Makinari",
        language: "en-US",
        maxDurationMinutes: 5,
        metadata: { messageId: "message_1" },
      });

      expect(global.fetch).toHaveBeenCalledWith(
        "https://api.zavu.dev/v1/calls",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            to: "+5215551234567",
            senderId: "sender_1",
            greeting: "Hello from Makinari",
            language: "en-US",
            maxDurationMinutes: 5,
            metadata: { messageId: "message_1" },
          }),
        })
      );
    });

    it("retrieves and hangs up a call", async () => {
      const call = {
        call: {
          id: "call/123",
          direction: "outbound",
          from: "+14155550100",
          to: "+5215551234567",
          status: "in_progress",
          createdAt: "2026-09-21T00:00:00.000Z",
        },
      };
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce(mockJson(200, call))
        .mockResolvedValueOnce(mockJson(202, call));

      await getVoiceCall("call/123");
      await hangupVoiceCall("call/123");

      expect(global.fetch).toHaveBeenNthCalledWith(
        1,
        "https://api.zavu.dev/v1/calls/call%2F123",
        expect.any(Object)
      );
      expect(global.fetch).toHaveBeenNthCalledWith(
        2,
        "https://api.zavu.dev/v1/calls/call%2F123/hangup",
        expect.objectContaining({ method: "POST" })
      );
    });
  });

  it("activates an email sender channel", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      mockJson(200, {
        sender: { id: "snd/1", channels: ["email"] },
        channel: "email",
        activated: true,
        chargedCents: 0,
        monthlyCents: 0,
      })
    );

    await activateSenderChannel("snd/1", "email");

    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.zavu.dev/v1/senders/snd%2F1/channels/email/activate",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("deleteSender sends DELETE /senders/:id", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(mockJson(204, {}));

    await deleteSender("snd_1");

    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.zavu.dev/v1/senders/snd_1",
      expect.objectContaining({ method: "DELETE" })
    );
  });

  it("creates a standalone managed agent", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      mockJson(201, { agent: { id: "agent_1", name: "Support" } })
    );

    const agent = await createStandaloneAgent({
      name: "Support",
      provider: "zavu",
      model: "openai/gpt-4o-mini",
      systemPrompt: "Help customers.",
    });

    expect(agent.id).toBe("agent_1");
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.zavu.dev/v1/agents",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("treats an explicitly empty sender agent as not found", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      mockJson(200, { agent: null })
    );

    await expect(getSenderAgent("sender_1")).rejects.toMatchObject({
      message: "Zavu agent not found",
      status: 404,
    });
  });

  it("attaches a sender to the requested agent instead of the legacy global agent", async () => {
    process.env.ZAVUDEV_AGENT_ID = "agent_global";
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      mockJson(201, { agent: { id: "agent_site" } })
    );

    await attachSenderToAgent("sender_1", "agent_site");

    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.zavu.dev/v1/agents/agent_site/senders",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ senderId: "sender_1" }),
      })
    );
  });

  it("updates an existing tool by name instead of creating duplicates", async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(mockJson(200, {
        items: [{ id: "tool_1", agentId: "agent_1", name: "capture_lead" }],
      }))
      .mockResolvedValueOnce(mockJson(200, {
        tool: { id: "tool_1", agentId: "agent_1", name: "capture_lead" },
      }));

    await upsertAgentTool("agent_1", {
      name: "capture_lead",
      description: "Capture a lead",
      parameters: { type: "object" },
      webhookUrl: "https://backend.example.com/voice-tools",
      webhookSecret: "secret",
    });

    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "https://api.zavu.dev/v1/agents/agent_1/tools/tool_1",
      expect.objectContaining({ method: "PATCH" })
    );
  });

  it("lists voices using the documented language filter", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(mockJson(200, {
      items: [{ id: "voice-es", name: "Celeste", language: "es" }],
      languages: ["auto", "es"],
      total: 1,
    }));

    await expect(listAgentVoices("es")).resolves.toMatchObject({
      items: [{ id: "voice-es" }],
      languages: ["auto", "es"],
    });
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.zavu.dev/v1/agents/voices?language=es",
      expect.any(Object)
    );
  });

});
