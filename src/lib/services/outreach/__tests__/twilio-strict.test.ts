jest.mock('@/lib/services/whatsapp/WhatsAppTemplateService', () => ({ WhatsAppTemplateService: { getTwilioErrorInfo: () => ({ type: 'ERROR', description: 'No sender', suggestion: 'configure' }) } }));
import { sendTwilioWhatsAppMessage } from '../../whatsapp/twilio-whatsapp-transport';
const params = { phoneNumber: '+15551234567', message: 'Hello', accountSid: 'AC-selected', authToken: 'secret', fromNumber: '+524611051101', strictSingleMessage: true };
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });
test('strict sender never falls back to another Mexican-number candidate on 63007', async () => {
  global.fetch = jest.fn(async () => ({ ok: false, status: 400, json: async () => ({ code: 63007, message: 'Sender unavailable' }) })) as any;
  expect((await sendTwilioWhatsAppMessage(params)).success).toBe(false);
  expect(global.fetch).toHaveBeenCalledTimes(1);
});
test('strict template sends exactly one ContentSid request without plain text or environment sender', async () => {
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ sid: 'SM-selected' }) })) as any;
  const result = await sendTwilioWhatsAppMessage({ ...params, contentSid: 'HX-selected', contentVariables: { '1': 'Ada' } });
  expect(result).toMatchObject({ success: true, messageId: 'SM-selected' });
  const request = (global.fetch as jest.Mock).mock.calls[0];
  expect(request[0]).toContain('/AC-selected/');
  const body = new URLSearchParams(request[1].body);
  expect(body.get('ContentSid')).toBe('HX-selected'); expect(body.get('Body')).toBeNull();
  expect(body.get('From')).toBe('whatsapp:+524611051101'); expect(body.get('MessagingServiceSid')).toBeNull();
  expect(global.fetch).toHaveBeenCalledTimes(1);
});
test('oversized strict message never splits into multiple physical sends', async () => {
  global.fetch = jest.fn();
  expect((await sendTwilioWhatsAppMessage({ ...params, message: 'x'.repeat(1501) })).success).toBe(false);
  expect(global.fetch).not.toHaveBeenCalled();
});