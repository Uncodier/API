import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';

const mockFrom = jest.fn();
const mockGetCall = jest.fn();
const mockClaim = jest.fn();
const mockFinish = jest.fn();
jest.mock('@/lib/database/supabase-server', () => ({
  supabaseAdmin: { from: mockFrom, schema: () => ({ from: mockFrom }) },
}));
jest.mock('@/lib/services/zavu', () => ({
  verifyZavuSignature: jest.requireActual('@/lib/services/zavu/signature').verifyZavuSignature,
}));
jest.mock('@/lib/services/zavu/webhook-handlers', () => ({
  ...jest.requireActual('@/lib/services/zavu/voice-webhook-handler'),
  findSettingsForSender: jest.fn(async () => []),
  handleInboundMessage: jest.fn(), handleDomainStatusChanged: jest.fn(), handleInvitationStatusChanged: jest.fn(),
}));
jest.mock('@/lib/services/zavu/voice-call-client', () => ({ getVoiceCall: (...args: unknown[]) => mockGetCall(...args) }));
jest.mock('@/lib/services/zavu/contact-client', () => ({ clearVoiceCallContactContext: jest.fn(), setVoiceCallContactContext: jest.fn() }));
jest.mock('@/lib/services/zavu/voice-agent-context', () => ({ ensureVoiceContactMetadataEnabled: jest.fn() }));
jest.mock('@/lib/services/zavu/voice-follow-up-context', () => ({ buildVoiceFollowUpContext: jest.fn() }));
jest.mock('@/lib/services/provider-webhook-claims', () => ({
  claimProviderWebhookEvent: (...args: unknown[]) => mockClaim(...args),
  finishProviderWebhookEvent: (...args: unknown[]) => mockFinish(...args),
}));
jest.mock('@/lib/utils/token-decryption', () => ({ decryptToken: jest.fn() }));

import { POST } from '../route';
import { inboundDatabase, SITE, OTHER_SITE, LEAD, PHONE, CALL } from '@/lib/services/zavu/__tests__/inbound-lead-test-database';
import { buildVoiceFollowUpContext } from '@/lib/services/zavu/voice-follow-up-context';
import { setVoiceCallContactContext } from '@/lib/services/zavu/contact-client';

const originalSecret = process.env.ZAVUDEV_WEBHOOK_SECRET;
function request(id: string, signed = true, type = 'call.completed') {
  const body = JSON.stringify({ id, type, senderId: 'sender-1', data: {
    callId: CALL, transcriptAvailable: true, site_id: OTHER_SITE, lead_id: OTHER_SITE,
  } });
  const t = Math.floor(Date.now() / 1000);
  const digest = createHmac('sha256', 'test-only-secret').update(`${t}.${body}`).digest('hex');
  return new NextRequest('https://api.example.test/api/integrations/zavu/webhook', {
    method: 'POST', body, headers: signed ? { 'x-zavu-signature': `t=${t},v2=${digest}` } : {},
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ZAVUDEV_WEBHOOK_SECRET = 'test-only-secret';
  mockClaim.mockResolvedValue({ state: 'claimed', token: 'claim' });
  mockFinish.mockResolvedValue(true);
  mockGetCall.mockResolvedValue({
    id: CALL, direction: 'inbound', from: PHONE, to: '+14155550999', status: 'completed',
    createdAt: '2026-09-30T00:00:00Z', endedAt: '2026-09-30T00:01:00Z',
    transcript: [{ seq: 0, role: 'user', text: 'I want a demo' }, { seq: 1, role: 'assistant', text: 'What day?' }],
  });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => {
  if (originalSecret === undefined) delete process.env.ZAVUDEV_WEBHOOK_SECRET;
  else process.env.ZAVUDEV_WEBHOOK_SECRET = originalSecret;
});

it('authenticates the webhook then creates one lead and links the real conversation/delivery/transcript across duplicate terminal events', async () => {
  const state = inboundDatabase(mockFrom);
  expect((await POST(request('event-1'))).status).toBe(200);
  expect((await POST(request('event-2'))).status).toBe(200);
  expect(state.tables.leads).toHaveLength(1);
  const lead = state.tables.leads[0];
  expect(lead).toMatchObject({ site_id: SITE, phone: PHONE, voice_call_consent_status: 'unknown' });
  expect(state.tables.conversations).toHaveLength(1);
  expect(state.tables.voice_call_deliveries).toHaveLength(1);
  expect(state.tables.messages).toHaveLength(3);
  expect([...state.tables.conversations, ...state.tables.voice_call_deliveries, ...state.tables.messages]
    .every(row => row.lead_id === lead.id)).toBe(true);
  expect(mockFinish).toHaveBeenLastCalledWith('zavu', 'event-2', 'claim', 'completed');
})

it('reuses a formatted same-site lead without changing its opt-outs', async () => {
  const state = inboundDatabase(mockFrom, { leads: [{
    id: LEAD, site_id: SITE, phone: '+1 (301) 555-0100', name: 'Existing',
    do_not_call: true, voice_call_consent_status: 'denied',
  }] });
  expect((await POST(request('event-1'))).status).toBe(200);
  expect(state.tables.leads).toHaveLength(1);
  expect(state.tables.conversations[0].lead_id).toBe(LEAD);
  expect(state.tables.leads[0]).toMatchObject({ name: 'Existing', do_not_call: true, voice_call_consent_status: 'denied' });
})

it.each(['525543640787', '+5215543640787', '(55) 4364-0787'])(
  'recognizes Mexican caller stored as %s at call start and links the same lead on completion', async phone => {
    const lead = { id: LEAD, site_id: SITE, phone, name: 'Existing', do_not_call: true, voice_call_consent_status: 'denied' };
    const state = inboundDatabase(mockFrom, { leads: [structuredClone(lead)] });
    mockGetCall.mockResolvedValue({
      id: CALL, direction: 'inbound', from: '+525543640787', status: 'completed',
      createdAt: '2026-10-01T00:00:00Z', endedAt: '2026-10-01T00:01:00Z',
      transcript: [{ seq: 0, role: 'user', text: 'Hello again' }],
    });
    jest.mocked(buildVoiceFollowUpContext).mockResolvedValue({
      context: 'Existing customer context', leadId: LEAD,
      sources: { leadFound: true, messageCount: 0, transcriptCount: 0 },
    });
    expect((await POST(request('started', true, 'call.initiated'))).status).toBe(200);
    expect(buildVoiceFollowUpContext).toHaveBeenCalledWith({ siteId: SITE, leadId: LEAD, phone: '+525543640787' });
    expect(setVoiceCallContactContext).toHaveBeenCalledWith(expect.objectContaining({
      phone: '+525543640787', followUpContext: 'Existing customer context',
    }));
    expect(state.operations.every(op => op.kind === 'read')).toBe(true);
    expect((await POST(request('completed'))).status).toBe(200);
    expect((await POST(request('completed-again'))).status).toBe(200);
    expect(state.tables.leads).toEqual([lead]);
    expect(state.tables.conversations).toHaveLength(1);
    expect(state.tables.voice_call_deliveries).toHaveLength(1);
    expect(state.tables.messages).toHaveLength(2);
    expect([...state.tables.conversations, ...state.tables.voice_call_deliveries, ...state.tables.messages]
      .every(row => row.lead_id === LEAD)).toBe(true);
  },
)

it('rejects unsigned events before admission, provider lookup or any contact writes', async () => {
  const state = inboundDatabase(mockFrom);
  expect((await POST(request('event-1', false))).status).toBe(401);
  expect(mockClaim).not.toHaveBeenCalled();
  expect(mockGetCall).not.toHaveBeenCalled();
  expect(state.operations).toHaveLength(0);
})

it('does not repeat completed claims or issue provider work for them', async () => {
  const state = inboundDatabase(mockFrom);
  mockClaim.mockResolvedValueOnce({ state: 'completed' });
  expect((await POST(request('already-done'))).status).toBe(200);
  expect(mockGetCall).not.toHaveBeenCalled();
  expect(state.operations).toHaveLength(0);
})

it('does not acknowledge partial persistence and completes it without duplication on a failed-claim retry', async () => {
  const state = inboundDatabase(mockFrom);
  state.failNextTable = 'messages';
  state.failNextKind = 'upsert';
  expect((await POST(request('event-retry'))).status).toBe(500);
  expect(mockFinish).toHaveBeenLastCalledWith('zavu', 'event-retry', 'claim', 'failed', expect.any(String));
  expect((await POST(request('event-retry'))).status).toBe(200);
  expect(state.tables.leads).toHaveLength(1);
  expect(state.tables.conversations).toHaveLength(1);
  expect(state.tables.messages).toHaveLength(3);
  expect(state.tables.messages.every(row => row.lead_id === state.tables.leads[0].id)).toBe(true);
})

it('repairs a historic null linkage on a new terminal event without changing message content', async () => {
  const state = inboundDatabase(mockFrom);
  expect((await POST(request('original'))).status).toBe(200);
  const content = state.tables.messages.map(row => row.content);
  for (const rows of [state.tables.conversations, state.tables.voice_call_deliveries, state.tables.messages]) {
    rows.forEach(row => { row.lead_id = null; });
  }
  expect((await POST(request('later-terminal'))).status).toBe(200);
  expect(state.tables.messages.map(row => row.content)).toEqual(content);
  expect(state.tables.messages.every(row => row.lead_id === state.tables.leads[0].id)).toBe(true);
  expect(state.tables.leads).toHaveLength(1);
})

it('rejects an ambiguous sender/site association without creating any contact', async () => {
  const state = inboundDatabase(mockFrom, { settings: [
    { site_id: SITE, channels: { connections: [{ zavu_sender_id: 'sender-1' }] } },
    { site_id: OTHER_SITE, channels: { connections: [{ zavu_sender_id: 'sender-1' }] } },
  ] });
  expect((await POST(request('ambiguous-sender'))).status).toBe(500);
  expect(state.tables.leads).toHaveLength(0);
  expect(state.tables.conversations).toHaveLength(0);
})

it('rejects a mismatched provider response before resolving the site or creating a contact', async () => {
  const state = inboundDatabase(mockFrom);
  mockGetCall.mockResolvedValueOnce({ id: 'different-call', direction: 'inbound', from: PHONE });
  expect((await POST(request('wrong-call'))).status).toBe(500);
  expect(state.tables.leads).toHaveLength(0);
  expect(state.tables.conversations).toHaveLength(0);
})

it('does not acknowledge failed linkage and retries against the already saved delivery without duplicating the lead', async () => {
  const state = inboundDatabase(mockFrom);
  state.failNextTable = 'messages';
  state.failNextKind = 'update';
  expect((await POST(request('link-retry'))).status).toBe(500);
  expect(state.tables.voice_call_deliveries).toHaveLength(1);
  expect((await POST(request('link-retry'))).status).toBe(200);
  expect(state.tables.leads).toHaveLength(1);
  expect(state.tables.messages).toHaveLength(3);
  expect(state.tables.messages.every(row => row.lead_id === state.tables.leads[0].id)).toBe(true);
})

it('does not let a terminal event for another sender mutate an existing call', async () => {
  const state = inboundDatabase(mockFrom);
  expect((await POST(request('original'))).status).toBe(200);
  state.tables.voice_call_deliveries[0].zavu_sender_id = 'other-sender';
  const operations = state.operations.length;
  expect((await POST(request('wrong-sender'))).status).toBe(500);
  expect(state.operations.slice(operations).every(operation => operation.kind === 'read')).toBe(true);
})