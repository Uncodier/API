import { sendTwilioWhatsAppMessage } from '../twilio-whatsapp-transport';

jest.mock('../WhatsAppTemplateService', () => ({
  WhatsAppTemplateService: {
    getTwilioErrorInfo: jest.fn((code: number) => ({
      description: code === 63007 ? 'Número remitente no encontrado o no configurado para WhatsApp' : 'Twilio error',
      suggestion: 'retry',
      type: 'SENDER_CONFIG',
    })),
  },
}));

describe('sendTwilioWhatsAppMessage', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  const base = {
    phoneNumber: '+5214611721870',
    message: 'Hola',
    accountSid: 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    authToken: 'token',
    fromNumber: '+524611051101',
  };

  it('sends with MessagingServiceSid and omits From', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sid: 'SM1', status: 'queued', from: 'whatsapp:+5214611051101', to: 'whatsapp:+5214611721870' }),
    }) as any;

    const result = await sendTwilioWhatsAppMessage({
      ...base,
      messagingServiceSid: 'MGbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('SM1');
    const body = (global.fetch as jest.Mock).mock.calls[0][1].body as string;
    expect(body).toContain('MessagingServiceSid=MGbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(body).not.toContain('From=');
  });

  it('retries From with +521 after Twilio 63007 on stored +52', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({
          code: 63007,
          message: 'Twilio could not find a Channel with the specified From address',
          status: 400,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sid: 'SM2', status: 'queued' }),
      }) as any;

    const result = await sendTwilioWhatsAppMessage(base);

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('SM2');
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(2);
    const firstBody = (global.fetch as jest.Mock).mock.calls[0][1].body as string;
    const secondBody = (global.fetch as jest.Mock).mock.calls[1][1].body as string;
    expect(decodeURIComponent(firstBody)).toContain('From=whatsapp:+5214611051101');
    expect(decodeURIComponent(secondBody)).toContain('From=whatsapp:+524611051101');
  });
});
