import { randomBytes } from 'node:crypto';
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn(), rpc: jest.fn() } }));
jest.mock('@/lib/services/zavu/client', () => ({ sendChannelMessage: jest.fn() }));
jest.mock('@/lib/services/zavu/voice-call-service', () => ({ assertVoiceCallAllowed: jest.fn(), placeTrackedVoiceCall: jest.fn() }));
jest.mock('@/lib/services/email/EmailSendService', () => ({ EmailSendService: { isValidEmail: () => true, sendEmail: jest.fn() } }));
jest.mock('@/lib/services/email/AgentMailSendService', () => ({ AgentMailSendService: { sendViaAgentMail: jest.fn() } }));
jest.mock('@/lib/services/email/EmailSignatureService', () => ({ EmailSignatureService: { generateAgentSignature: jest.fn() } }));
jest.mock('../exact-email-content', () => ({ exactEmailContent: (text: string) => ({ text }) }));
jest.mock('@/lib/services/whatsapp/WhatsAppTemplateService', () => ({ WhatsAppTemplateService: {} }));
jest.mock('@/lib/services/whatsapp/twilio-whatsapp-transport', () => ({ sendTwilioWhatsAppMessage: jest.fn() }));
jest.mock('../lead-merge-fields', () => ({ fetchSiteNameForMerge: async () => 'Site',
  personalizeMergeSubjectAndMessage: (subject: string, message: string) => ({ subject, message }),
  placeholderPolicyToMergePolicy: () => 'strip_unresolved' }));
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { sendChannelMessage } from '@/lib/services/zavu/client';
import { sendExactDelivery } from '../exact-delivery';
import { resolveDeliveryRoutes } from '../delivery-routing';
import { getSiteLicensedResources, requireLicensedSocialAccounts } from '@/lib/billing/licensed-resources';

const input = { site_id: '11111111-1111-4111-8111-111111111111', channel: 'telegram' as const,
  connection_id: 'chosen', to: '123456', message: 'Hello' };
const raw = { id: 'chosen', type: 'telegram', status: 'connected', zavu_sender_id: randomBytes(12).toString('hex') };
const projection = (suspended = false) => ({ effective_plan: suspended ? 'commission' : 'engine',
  channels: { connections: [{ ...raw, status: suspended ? 'license_suspended' : 'connected', license_suspended: suspended }] },
  social_media: [{ id: 'social', isActive: !suspended, license_suspended: suspended }] });
const rpcResult = (data: unknown, error: unknown = null) => ({ abortSignal: () => Promise.resolve({ data, error }) });

beforeEach(() => {
  jest.clearAllMocks();
  (supabaseAdmin.rpc as jest.Mock).mockReturnValue(rpcResult(projection()));
  (sendChannelMessage as jest.Mock).mockResolvedValue({ message: { id: 'accepted', status: 'queued' } });
});

test('authorized active trial uses RPC at selection and dispatch, never raw settings', async () => {
  expect((await sendExactDelivery(input)).success).toBe(true);
  expect(supabaseAdmin.rpc).toHaveBeenCalledTimes(2);
  expect(supabaseAdmin.rpc).toHaveBeenCalledWith('get_site_licensed_resources', { p_site_id: input.site_id });
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
  expect(sendChannelMessage).toHaveBeenCalledWith(expect.objectContaining({ senderId: raw.zavu_sender_id }));
});

test('trial expiring between preparation and send denies provider and durable dispatch hook', async () => {
  (supabaseAdmin.rpc as jest.Mock).mockReturnValueOnce(rpcResult(projection()))
    .mockReturnValueOnce(rpcResult(projection(true)));
  const before = jest.fn();
  expect(await sendExactDelivery({ ...input, before_dispatch: before })).toMatchObject({ success: false, delivery_attempted: false });
  expect(before).not.toHaveBeenCalled();
  expect(sendChannelMessage).not.toHaveBeenCalled();
});

test.each([{ enabled: false }, { _license: { manually_disabled: true } }])(
  'manual disable at exact dispatch prevents provider delivery: %j', async extra => {
    const denied = projection();
    Object.assign(denied.channels.connections[0], extra);
    (supabaseAdmin.rpc as jest.Mock).mockReturnValueOnce(rpcResult(projection()))
      .mockReturnValueOnce(rpcResult(denied));
    const before = jest.fn();
    expect(await sendExactDelivery({ ...input, before_dispatch: before })).toMatchObject({
      success: false, delivery_attempted: false,
    });
    expect(before).not.toHaveBeenCalled();
    expect(sendChannelMessage).not.toHaveBeenCalled();
  },
);

test('expired raw connected resource cannot resolve destinations or social publication', async () => {
  (supabaseAdmin.rpc as jest.Mock).mockReturnValue(rpcResult(projection(true)));
  await expect(resolveDeliveryRoutes(input.site_id, { channel: input.channel, connection_id: input.connection_id })).rejects.toThrow();
  await expect(requireLicensedSocialAccounts(input.site_id, ['social'])).rejects.toThrow();
  expect(raw.status).toBe('connected');
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
});

test.each([null, {}, { ...projection(), channels: null }, { ...projection(), effective_plan: 'startup' },
  { ...projection(), social_media: [{ id: 'social', isActive: true }] },
  { ...projection(), channels: { connections: 'invalid' } },
])('missing/null/malformed projection fails closed without fallback: %j', async data => {
  (supabaseAdmin.rpc as jest.Mock).mockReturnValue(rpcResult(data));
  await expect(getSiteLicensedResources(input.site_id)).rejects.toMatchObject({ code: 'RESOURCE_LICENSE_UNAVAILABLE' });
  expect((await sendExactDelivery(input)).success).toBe(false);
  expect(sendChannelMessage).not.toHaveBeenCalled();
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
});

test('missing RPC or thrown database error never reads old settings', async () => {
  (supabaseAdmin.rpc as jest.Mock).mockReturnValue(rpcResult(projection(), { code: 'PGRST202' }));
  await expect(getSiteLicensedResources(input.site_id)).rejects.toThrow();
  (supabaseAdmin.rpc as jest.Mock).mockImplementation(() => { throw new Error('unavailable'); });
  await expect(getSiteLicensedResources(input.site_id)).rejects.toThrow();
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
});

test('social IDs must match unique licensed inventory, not provider active state alone', async () => {
  await expect(requireLicensedSocialAccounts(input.site_id, ['social'])).resolves.toBeUndefined();
  await expect(requireLicensedSocialAccounts(input.site_id, ['foreign'])).rejects.toThrow();
  const data = projection(); data.social_media.push(data.social_media[0]);
  (supabaseAdmin.rpc as jest.Mock).mockReturnValue(rpcResult(data));
  await expect(requireLicensedSocialAccounts(input.site_id, ['social'])).rejects.toThrow();
});

test('unrelated draft resources do not deny a valid licensed sender', async () => {
  const data: any = projection();
  data.social_media.push({ id: 'draft', license_suspended: false });
  data.channels.connections.push({ id: 'draft-channel', license_suspended: false });
  (supabaseAdmin.rpc as jest.Mock).mockReturnValue(rpcResult(data));
  expect((await sendExactDelivery(input)).success).toBe(true);
  await expect(requireLicensedSocialAccounts(input.site_id, ['draft'])).rejects.toThrow();
});

test('caller cancellation rejects even when the RPC transport ignores abort', async () => {
  const controller = new AbortController();
  (supabaseAdmin.rpc as jest.Mock).mockReturnValue({ abortSignal: () => new Promise(() => {}) });
  const pending = getSiteLicensedResources(input.site_id, controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ status: 503 });
});