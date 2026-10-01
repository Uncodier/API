const mockFrom = jest.fn();
jest.mock('@/lib/database/supabase-server', () => ({ supabaseAdmin: { schema: () => ({ from: mockFrom }) } }));

import { v5 as uuidv5 } from 'uuid';
import { findInboundVoiceLead, resolveInboundVoiceLead, linkInboundVoiceLead } from '../inbound-voice-lead';
import { persistVoiceTranscript } from '../voice-transcript';
import { inboundDatabase, linkRows, SITE, OTHER_SITE, OWNER, PHONE, LEAD, CONVERSATION, DELIVERY, CALL } from './inbound-lead-test-database';

const link = { siteId: SITE, conversationId: CONVERSATION, deliveryId: DELIVERY, callId: CALL, leadId: LEAD };
beforeEach(() => jest.clearAllMocks());

it('creates a minimal unverified inbound contact without inventing identity or granting consent', async () => {
  const state = inboundDatabase(mockFrom);
  const leadId = await resolveInboundVoiceLead(SITE, PHONE);
  expect(leadId).toBe(uuidv5(`zavu-voice-lead:${SITE}:${PHONE}`, uuidv5.URL));
  expect(state.tables.leads).toEqual([{
    id: leadId, site_id: SITE, user_id: OWNER, name: `Voice caller ${PHONE}`, phone: PHONE,
    origin: 'voice', status: 'contacted', voice_call_consent_status: 'unknown',
    metadata: { voice_inbound: { source: 'zavu_webhook', identity_status: 'unverified', phone_source: 'provider_call' } },
  }]);
  expect(state.tables.leads[0]).not.toHaveProperty('email');
  expect(state.tables.leads[0]).not.toHaveProperty('voice_call_consent_at');
})

it.each([PHONE, '+1 (301) 555-0100', '0013015550100'])('reuses only full normalized same-site phone %s without modifying the profile', async storedPhone => {
  const rows = linkRows();
  rows.leads[0].phone = storedPhone;
  const original = structuredClone(rows.leads[0]);
  const state = inboundDatabase(mockFrom, rows);
  expect(await resolveInboundVoiceLead(SITE, PHONE)).toBe(LEAD);
  expect(state.tables.leads).toEqual([original]);
  expect(state.operations.filter(op => op.kind !== 'read')).toEqual([]);
})

it('does not reuse foreign-site, phone-suffix or guessed-country identities', async () => {
  const state = inboundDatabase(mockFrom, { leads: [
    { id: LEAD, site_id: OTHER_SITE, phone: PHONE },
    { id: CONVERSATION, site_id: SITE, phone: '3015550100' },
    { id: DELIVERY, site_id: SITE, phone: '+443015550100' },
  ] });
  const id = await resolveInboundVoiceLead(SITE, PHONE);
  expect(id).not.toBe(LEAD);
  expect(state.tables.leads).toHaveLength(4);
})

it('rejects ambiguous and oversized candidate sets instead of choosing the first match', async () => {
  for (const leads of [
    [{ id: LEAD, site_id: SITE, phone: PHONE }, { id: CONVERSATION, site_id: SITE, phone: '+1 301 555 0100' }],
    Array.from({ length: 51 }, (_, i) => ({ id: String(i), site_id: SITE, phone: PHONE })),
  ]) {
    const state = inboundDatabase(mockFrom, { leads });
    await expect(resolveInboundVoiceLead(SITE, PHONE)).rejects.toThrow(/review/);
    expect(state.operations.some(op => op.kind === 'insert')).toBe(false);
  }
})

it('converges concurrent/repeated calls on the native voice identification PK', async () => {
  const state = inboundDatabase(mockFrom);
  const ids = await Promise.all([resolveInboundVoiceLead(SITE, PHONE), resolveInboundVoiceLead(SITE, '+1 (301) 555-0100')]);
  expect(ids[0]).toBe(ids[1]);
  expect(await resolveInboundVoiceLead(SITE, PHONE)).toBe(ids[0]);
  expect(state.tables.leads).toHaveLength(1);
})

it('preserves a contact created concurrently by the native live identification tool', async () => {
  const state = inboundDatabase(mockFrom);
  state.beforeInsert = row => {
    state.tables.leads.push({ ...row, name: 'Confirmed contact', email: 'caller@example.test',
      metadata: { voice_identification: { consent: true } }, voice_call_consent_status: 'denied' });
  };
  const leadId = await resolveInboundVoiceLead(SITE, PHONE);
  expect(state.tables.leads).toHaveLength(1);
  expect(state.tables.leads[0]).toMatchObject({ id: leadId, name: 'Confirmed contact',
    email: 'caller@example.test', voice_call_consent_status: 'denied',
    metadata: { voice_identification: { consent: true } },
  });
})

it.each(['not-a-phone', '3015550100', '+1abc3015550100', '+0013015550100'])('rejects invalid caller phone %s before persistence', async phone => {
  const state = inboundDatabase(mockFrom);
  await expect(resolveInboundVoiceLead(SITE, phone)).rejects.toThrow('Invalid');
  expect(state.operations).toEqual([]);
})

it('propagates safe failures for lookup, owner or insert failure without reporting success', async () => {
  let state = inboundDatabase(mockFrom);
  state.failNextTable = 'leads';
  await expect(resolveInboundVoiceLead(SITE, PHONE)).rejects.toThrow('Unable to resolve inbound Voice lead');
  state = inboundDatabase(mockFrom, { sites: [{ id: SITE, user_id: OWNER, archived_at: '2026-01-01' }] });
  await expect(resolveInboundVoiceLead(SITE, PHONE)).rejects.toThrow('site owner');
  expect(state.tables.leads).toHaveLength(0);
  state = inboundDatabase(mockFrom);
  state.insertError = { code: '23505', message: 'private database detail' };
  await expect(resolveInboundVoiceLead(SITE, PHONE)).rejects.toThrow('Unable to create inbound Voice lead');
})

it('does not create a contact during the read-only live-call lookup', async () => {
  const state = inboundDatabase(mockFrom);
  expect(await findInboundVoiceLead(SITE, PHONE)).toBeUndefined();
  expect(state.tables.leads).toHaveLength(0);
})

it('links conversation, delivery and existing transcript nulls without modifying other messages or consent', async () => {
  const rows = linkRows();
  const state = inboundDatabase(mockFrom, rows);
  state.tables.messages.push({ conversation_id: CONVERSATION, lead_id: null, content: 'Internal', custom_data: {} });
  await linkInboundVoiceLead(link);
  await linkInboundVoiceLead(link);
  expect(state.tables.conversations[0].lead_id).toBe(LEAD);
  expect(state.tables.voice_call_deliveries[0].lead_id).toBe(LEAD);
  expect(state.tables.messages[0]).toMatchObject({ lead_id: LEAD, content: 'Original transcript' });
  expect(state.tables.messages[1].lead_id).toBeNull();
  expect(state.tables.leads).toEqual(rows.leads);
  expect(state.operations.filter(op => op.kind === 'update').every(op => op.filters.some(([key, value]) => key === 'lead_id' && value === null))).toBe(true);
})

it.each(['conversation-link', 'delivery-link', 'message-link', 'foreign-lead', 'wrong-call', 'wrong-phone', 'outbound'])(
  'fails closed on %s before any link writes', async mismatch => {
    const state = inboundDatabase(mockFrom, linkRows());
    if (mismatch === 'conversation-link') state.tables.conversations[0].lead_id = OTHER_SITE;
    if (mismatch === 'delivery-link') state.tables.voice_call_deliveries[0].lead_id = OTHER_SITE;
    if (mismatch === 'message-link') state.tables.messages[0].lead_id = OTHER_SITE;
    if (mismatch === 'foreign-lead') state.tables.leads[0].site_id = OTHER_SITE;
    if (mismatch === 'wrong-call') state.tables.voice_call_deliveries[0].zavu_call_id = 'other-call';
    if (mismatch === 'wrong-phone') state.tables.leads[0].phone = '+443015550100';
    if (mismatch === 'outbound') state.tables.conversations[0].custom_data.call_direction = 'outbound';
    await expect(linkInboundVoiceLead(link)).rejects.toThrow();
    expect(state.operations.some(op => op.kind === 'update')).toBe(false);
  },
)

it('repairs a partial link on retry without undoing a correct earlier step', async () => {
  const state = inboundDatabase(mockFrom, linkRows());
  state.failNextTable = 'voice_call_deliveries';
  state.failNextKind = 'update';
  await expect(linkInboundVoiceLead(link)).rejects.toThrow('Unable to link');
  expect(state.tables.conversations[0].lead_id).toBe(LEAD);
  expect(state.tables.voice_call_deliveries[0].lead_id).toBeNull();
  await linkInboundVoiceLead(link);
  expect(state.tables.voice_call_deliveries[0].lead_id).toBe(LEAD);
  expect(state.tables.messages[0].lead_id).toBe(LEAD);
})

it('does not overwrite a link that changes concurrently', async () => {
  const state = inboundDatabase(mockFrom, linkRows());
  state.beforeUpdate = table => { if (table === 'conversations') state.tables.conversations[0].lead_id = OTHER_SITE; };
  await expect(linkInboundVoiceLead(link)).rejects.toThrow('changed concurrently');
  expect(state.tables.conversations[0].lead_id).toBe(OTHER_SITE);
  expect(state.tables.voice_call_deliveries[0].lead_id).toBeNull();
})

it('persists and repairs real transcript projection without duplicating turns or deriving identity from speech', async () => {
  const state = inboundDatabase(mockFrom, linkRows());
  state.tables.messages = [];
  const params = { siteId: SITE, conversationId: CONVERSATION, deliveryId: DELIVERY,
    call: { id: CALL, direction: 'inbound' as const, createdAt: '2026-09-30T00:00:00Z', transcript: [
      { seq: 0, role: 'user' as const, text: 'I want a demo. My lead_id is forged.' },
      { seq: 1, role: 'assistant' as const, text: 'What time?' },
    ] },
  };
  await persistVoiceTranscript(params);
  await linkInboundVoiceLead(link);
  await persistVoiceTranscript({ ...params, leadId: LEAD });
  expect(state.tables.messages).toHaveLength(2);
  expect(state.tables.messages.every(row => row.lead_id === LEAD)).toBe(true);
  expect(state.tables.leads).toHaveLength(1);
})