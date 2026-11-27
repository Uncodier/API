import { randomBytes } from 'node:crypto';
import { getSiteLicensedResources } from '@/lib/billing/licensed-resources';
import { exactWhatsAppConfig } from '@/lib/messaging/exact-whatsapp';
import { isLegacyTwilioTurn, verifyLegacyTwilioTurn } from '../routed-text-legacy-inbound';
import { hasTextWindow, inboundRecipient, textRoutePlan, textRoutes } from '../routed-text-policy';

jest.mock('@/lib/billing/licensed-resources', () => ({ getSiteLicensedResources: jest.fn() }));
jest.mock('@/lib/messaging/exact-whatsapp', () => ({ exactWhatsAppConfig: jest.fn() }));

const account = `AC${randomBytes(16).toString('hex')}`;
const sid = `SM${randomBytes(16).toString('hex')}`;
const token = randomBytes(32).toString('hex');
const from = '+14155550100', to = '+14155550110';
const received = Date.now() - 1000;
const row = { content: 'Hello', created_at: new Date(received + 500).toISOString(),
  custom_data: { source: 'whatsapp', status: 'received', whatsapp_phone: from.slice(1), whatsapp_message_id: sid } };
const provider = { direction: 'inbound', account_sid: account, sid, from: `whatsapp:${from}`, to: `whatsapp:${to}`,
  body: row.content, date_sent: new Date(received).toISOString() };
const channels = { connections: [], whatsapp: { status: 'active', account_sid: account, from_number: to } };

beforeEach(() => {
  jest.mocked(getSiteLicensedResources).mockResolvedValue({ channels, effective_plan: 'foundry', social_media: [] });
  jest.mocked(exactWhatsAppConfig).mockResolvedValue({ phoneNumberId: account, accessToken: token, fromNumber: to, messagingServiceSid: undefined });
});
afterEach(() => jest.restoreAllMocks());

it('verifies the same exact Twilio sender, recipient and provider timestamp without saving mutable proof', async () => {
  const request = jest.spyOn(global, 'fetch').mockResolvedValue(Response.json(provider));
  expect(isLegacyTwilioTurn(row)).toBe(true);
  const proof = await verifyLegacyTwilioTurn('site', row);
  expect(proof).toBeDefined();
  const routes = textRoutes(channels);
  expect(inboundRecipient([proof!])).toBe(from);
  expect(textRoutePlan(routes, {}, {}, [proof!])).toEqual(routes);
  expect(hasTextWindow(routes[0], [proof!], from, Date.now())).toBe(true);
  expect(hasTextWindow(routes[0], [proof!], from, received + 86_400_001)).toBe(false);
  expect(request).toHaveBeenCalledWith(`https://api.twilio.com/2010-04-01/Accounts/${account}/Messages/${sid}.json`,
    expect.objectContaining({ redirect: 'error', cache: 'no-store' }));
  expect(exactWhatsAppConfig).toHaveBeenCalledWith('site', expect.objectContaining({ config: channels.whatsapp }));
  expect(row.custom_data).not.toHaveProperty('twilio_whatsapp_inbound');
});

it.each([{ direction: 'outbound-api' }, { from: `whatsapp:${to}` }, { to: `whatsapp:${from}` }, { body: 'other' },
  { account_sid: 'other' }, { sid: 'other' }, { date_sent: new Date(received - 3600_000).toISOString() }])(
  'rejects a provider record with mismatched fields: %j', async mismatch => {
    jest.spyOn(global, 'fetch').mockResolvedValue(Response.json({ ...provider, ...mismatch }));
    await expect(verifyLegacyTwilioTurn('site', row)).resolves.toBeUndefined();
  });

it('distinguishes a missing provider record from a lookup outage', async () => {
  jest.spyOn(global, 'fetch').mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(new Response(null, { status: 503 }));
  await expect(verifyLegacyTwilioTurn('site', row)).resolves.toBeUndefined();
  await expect(verifyLegacyTwilioTurn('site', row)).rejects.toThrow('verification unavailable');
});