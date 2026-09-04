import {
  createSender,
  ensureProjectWebhook,
  ensureSenderWebhook,
  ZAVU_PROJECT_WEBHOOK_EVENTS,
  ZAVU_SENDER_WEBHOOK_EVENTS,
  sendChannelMessage
} from "../client";

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

});
