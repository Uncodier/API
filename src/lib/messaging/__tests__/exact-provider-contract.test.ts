import { randomBytes } from 'node:crypto';

// Only infrastructure is replaced. The adapter, HTTP clients, email rendering,
// tracking, receipt writer and AgentMail callback lookup are the real modules.
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/database/supabase-server', () => ({
  supabaseAdmin: require('@/lib/database/supabase-client').supabaseAdmin,
}));
jest.mock('@/lib/database/task-db', () => ({ createTask: jest.fn() }));
jest.mock('@/lib/helpers/command-utils', () => ({ isValidUUID: (value: string) => /^[a-f0-9-]{36}$/i.test(value) }));
jest.mock('@/lib/security/upstash-rest', () => ({ claimKey: jest.fn(), sha256: jest.fn() }));
jest.mock('@/lib/services/email/EmailConfigService', () => ({ EmailConfigService: {} }));
jest.mock('@/lib/services/email/SentEmailDuplicationService', () => ({ SentEmailDuplicationService: {} }));
jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));
jest.mock('@/lib/services/synced-objects/SyncedObjectsService', () => ({ SyncedObjectsService: { createObject: jest.fn() } }));
jest.mock('@/lib/services/zavu/voice-call-service', () => ({ assertVoiceCallAllowed: jest.fn(), placeTrackedVoiceCall: jest.fn() }));
jest.mock('@/lib/services/email/EmailSignatureService', () => ({
  EmailSignatureService: { generateAgentSignature: jest.fn(async () => ({ formatted: '<p>Selected signature</p>' })) },
}));

import { sendExactDelivery } from '../exact-delivery';
import { claimExactDelivery, finishExactDelivery } from '../exact-delivery-receipt';
import { findMessageWithFallback, updateMessageWithAgentMailEvent } from '@/lib/integrations/agentmail/message-updater';
import { supabaseAdmin } from '@/lib/database/supabase-client';

const siteId = '11111111-1111-4111-8111-111111111111';
const messageId = '22222222-2222-4222-8222-222222222222';
const conversationId = '33333333-3333-4333-8333-333333333333';
const leadId = '44444444-4444-4444-8444-444444444444';
type Row = Record<string, any>;
let channels: Row;
let message: Row;
let requests: Array<{ url: string; headers: Headers; body: Row }>;
let responseStatus: number;
let providerStatus: string | undefined;
let providerId: string;
const originalFetch = global.fetch;
const originalEnv = { zavu: process.env.ZAVUDEV_API_KEY, agentmail: process.env.AGENTMAIL_API_KEY, tracking: process.env.NEXT_PUBLIC_API_URL };

function valueAt(row: Row, field: string): unknown {
  const parts = field.split(/->>?/).map(part => part.replace(/^['"]|['"]$/g, ''));
  return parts.reduce<unknown>((value, key) => value && typeof value === 'object' ? (value as Row)[key] : undefined, row);
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ZAVUDEV_API_KEY = randomBytes(24).toString('hex');
  process.env.AGENTMAIL_API_KEY = randomBytes(24).toString('hex');
  process.env.NEXT_PUBLIC_API_URL = 'https://tracking.example.invalid';
  channels = { connections: [
    { id: 'first', type: 'email', status: 'connected', zavu_sender_id: 'sender-first' },
    { id: 'selected', type: 'email', status: 'connected', zavu_sender_id: 'sender-selected' },
  ] };
  message = { id: messageId, conversation_id: conversationId, lead_id: leadId, role: 'assistant',
    created_at: '2026-10-01T00:00:00Z', content: '<p>Hello <strong>Ada</strong></p><a href="https://example.invalid/news">Read news</a>',
    custom_data: { connection_id: 'selected', channel: 'email', status: 'sending', subject: 'Stored subject' } };
  requests = []; responseStatus = 202; providerStatus = 'queued'; providerId = 'provider-selected-message';
  global.fetch = jest.fn(async (url, init) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    const payload = String(url).includes('agentmail.to')
      ? { message_id: providerId, thread_id: 'provider-thread' }
      : { message: { id: providerId, status: providerStatus } };
    return new Response(JSON.stringify(payload), { status: responseStatus, headers: { 'content-type': 'application/json' } });
  });
  (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
    let patch: Row | undefined;
    const filters: Array<[string, unknown]> = [];
    const query: Row = {};
    query.select = query.order = query.limit = () => query;
    query.eq = (key: string, value: unknown) => { filters.push([key, value]); return query; };
    query.filter = (key: string, _operator: string, value: unknown) => { filters.push([key, value]); return query; };
    query.update = (value: Row) => { patch = value; return query; };
    const result = (single: boolean) => {
      const rows: Row[] = table === 'settings' ? [{ site_id: siteId, channels }]
        : table === 'sites' ? [{ id: siteId, name: 'Selected site' }]
          : table === 'leads' ? [{ id: leadId, site_id: siteId, name: 'Ada', email: 'ada@example.invalid' }]
            : table === 'conversations' ? [{ id: conversationId, site_id: siteId, lead_id: leadId, channel: 'email' }]
              : table === 'messages' ? [message] : [];
      const selected = rows.filter(row => filters.every(([key, value]) => key === 'custom_data'
        ? JSON.stringify(row.custom_data) === value : valueAt(row, key) === value));
      if (patch && selected.length && table === 'messages') message = { ...message, ...patch };
      return { data: single ? selected[0] ?? null : selected, error: null };
    };
    query.single = query.maybeSingle = async () => result(true);
    query.then = (resolve: (value: Row) => unknown) => Promise.resolve(result(false)).then(resolve);
    return query;
  });
});

afterAll(() => {
  global.fetch = originalFetch;
  for (const [key, value] of Object.entries({ ZAVUDEV_API_KEY: originalEnv.zavu, AGENTMAIL_API_KEY: originalEnv.agentmail, NEXT_PUBLIC_API_URL: originalEnv.tracking })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

const input = () => ({ site_id: siteId, channel: 'email' as const, connection_id: 'selected',
  message_id: messageId, conversation_id: conversationId, lead_id: leadId, to: 'ada@example.invalid', message: message.content });

it.each(['queued', 'sending', 'sent', 'delivered', 'read'])('accepts documented Zavu %s through the actual HTTP client', async status => {
  providerStatus = status;
  const result = await sendExactDelivery(input());
  expect(result).toMatchObject({ success: true, status, messageId: providerId });
  expect(requests[0].headers.get('Zavu-Sender')).toBe('sender-selected');
});

it.each(['failed', 'rejected', 'cancelled', 'unknown', undefined])('refuses Zavu replay status %s and never writes a sent receipt', async status => {
  providerStatus = status; responseStatus = 409;
  const snapshot = structuredClone(message);
  let attempt: string | undefined;
  const result = await sendExactDelivery({ ...input(), before_dispatch: async () => { attempt = await claimExactDelivery(snapshot, 'selected'); } });
  expect(result.success).toBe(false);
  expect(requests).toHaveLength(1);
  await finishExactDelivery(messageId, attempt!, result);
  expect(message.custom_data.status).toBe('sending');
  expect(message.custom_data.exact_delivery_receipt.state).toBe('unknown');
  expect(message.custom_data.sent_at).toBeUndefined();
});

it('transmits actual HTML, selected signature, plain text and tracked links with the exact Zavu sender', async () => {
  expect((await sendExactDelivery(input())).success).toBe(true);
  const body = requests[0].body;
  expect(body.subject).toBe('Stored subject');
  expect(body.htmlBody).toContain('<strong>Ada</strong>');
  expect(body.htmlBody).toContain('Selected signature');
  expect(body.htmlBody).toContain(`m=${messageId}&amp;a=click`);
  expect(body.htmlBody).toContain(`m=${messageId}&amp;a=open`);
  expect(body.text).toContain('Hello Ada');
  expect(body.text).toContain('Selected signature');
  expect(body.text).not.toMatch(/<\/?(?:p|a|strong|img)\b/);
});

it('preserves newsletter HTML while omitting the signature', async () => {
  expect((await sendExactDelivery({ ...input(), omit_signature: true })).success).toBe(true);
  expect(requests[0].body.htmlBody).toContain('<strong>Ada</strong>');
  expect(requests[0].body.htmlBody).not.toContain('Selected signature');
  expect(requests[0].body.text).not.toContain('Selected signature');
});

it('correlates a delayed AgentMail bounce by canonical provider ID after exact receipt persistence', async () => {
  channels.agent_email = { status: 'active', username: 'selected', domain: 'example.invalid' };
  message.custom_data.connection_id = 'legacy:agent_email';
  const snapshot = structuredClone(message);
  let attempt: string | undefined;
  const result = await sendExactDelivery({ ...input(), connection_id: 'legacy:agent_email',
    before_dispatch: async () => { attempt = await claimExactDelivery(snapshot, 'legacy:agent_email'); } });
  expect(result.success).toBe(true);
  expect(requests[0].url).toContain('/inboxes/selected@example.invalid/messages/send');
  await finishExactDelivery(messageId, attempt!, result);
  expect(message.custom_data).toMatchObject({ connection_id: 'legacy:agent_email', status: 'sent',
    agentmail_message_id: providerId, agentmail_thread_id: 'provider-thread', agentmail_inbox_id: 'selected@example.invalid' });
  const found = await findMessageWithFallback(providerId, {
    recipient: 'ada@example.invalid', timestamp: '2026-10-16T00:00:00Z', subject: 'Stored subject',
  });
  expect(found?.id).toBe(messageId);
  expect(found?.foundViaFallback).toBeUndefined();
  expect((await updateMessageWithAgentMailEvent({ messageId, agentmailMessageId: providerId, status: 'bounced', eventType: 'message.bounced' })).success).toBe(true);
  expect(message.custom_data.status).toBe('bounced');
  expect(message.custom_data.connection_id).toBe('legacy:agent_email');
  expect(message.custom_data.exact_delivery_receipt.state).toBe('accepted');
});