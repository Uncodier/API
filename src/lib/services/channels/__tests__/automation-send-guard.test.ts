import { supabaseAdmin } from '@/lib/database/supabase-client';
import { assertAutomationSendAllowed, AutomationSendSuppressed, automationSkippedResult } from '../automation-send-guard';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { schema: jest.fn(), from: jest.fn() } }));

const input = { site_id: 'site', conversation_id: 'conversation', message_id: 'message', message: 'Saved reply' };
let conversation: any;
let message: any;
let writes: any[];
let filters: any[];
let failRead = false;
let loseWrite = false;

beforeEach(() => {
  jest.clearAllMocks();
  conversation = { id: 'conversation', automation_paused_until: null, last_human_reply_at: null, automation_snooze_hours: 24 };
  message = { id: 'message', conversation_id: 'conversation', role: 'assistant', content: input.message,
    created_at: '2026-01-01T01:00:00Z', custom_data: { source: 'telegram', automation_started_at: '2026-01-01T00:00:00Z' } };
  writes = []; filters = []; failRead = false; loseWrite = false;
  (supabaseAdmin.schema as jest.Mock).mockReturnValue(supabaseAdmin);
  (supabaseAdmin.from as jest.Mock).mockImplementation(table => {
    let writing = false;
    const query: any = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn((...args) => { filters.push([table, ...args]); return query; }),
      is: jest.fn().mockReturnThis(),
      update: jest.fn(data => { writing = true; writes.push(data); return query; }),
      maybeSingle: jest.fn(async () => ({ error: failRead ? new Error('offline') : null,
        data: writing ? (loseWrite ? null : { id: 'message' }) : table === 'conversations' ? conversation : message })),
    };
    return query;
  });
});

test('active pause returns terminal success skipped and preserves metadata in CAS write', async () => {
  conversation.automation_paused_until = '2999-01-01T00:00:00Z';
  let suppressed: any;
  try { await assertAutomationSendAllowed(input); } catch (error) { suppressed = error; }
  expect(suppressed).toBeInstanceOf(AutomationSendSuppressed);
  expect(automationSkippedResult(suppressed)).toEqual({ success: true, status: 'skipped', skipped: true, reason: 'agent_snoozed', delivered: false });
  expect(writes[0].custom_data).toMatchObject({ ...message.custom_data, status: 'skipped', automation_skipped: true, automation_skip_reason: 'agent_snoozed' });
  expect(filters).toContainEqual(['conversations', 'site_id', 'site']);
  expect(filters).toContainEqual(['messages', 'conversation_id', 'conversation']);
  expect(filters).toContainEqual(['messages', 'custom_data', JSON.stringify(message.custom_data)]);
});

test.each(['2026-01-01T00:00:00Z', '2026-01-01T00:30:00Z'])('supersedes generation even before created_at: %s', async human => {
  conversation.last_human_reply_at = human;
  await expect(assertAutomationSendAllowed(input)).rejects.toMatchObject({ reason: 'stale_automatic_reply' });
});
test('created_at fallback and fresh generation after human', async () => {
  delete message.custom_data.automation_started_at;
  conversation.last_human_reply_at = '2026-01-01T00:30:00Z';
  await expect(assertAutomationSendAllowed(input)).resolves.toBeUndefined();
  conversation.last_human_reply_at = '2026-01-01T01:30:00Z';
  await expect(assertAutomationSendAllowed(input)).rejects.toMatchObject({ reason: 'stale_automatic_reply' });
});
test('terminal skipped stays skipped after expiry and never rewrites receipts', async () => {
  message.custom_data.automation_skipped = true;
  message.custom_data.automation_skip_reason = 'agent_snoozed';
  await expect(assertAutomationSendAllowed(input)).rejects.toBeInstanceOf(AutomationSendSuppressed);
  expect(writes).toHaveLength(0);
});
test('only persisted team_member with exact content bypasses', async () => {
  conversation.automation_paused_until = '2999-01-01T00:00:00Z';
  await expect(assertAutomationSendAllowed({ ...input, ...{ role: 'team_member' } })).rejects.toBeInstanceOf(AutomationSendSuppressed);
  message.role = 'team_member';
  await expect(assertAutomationSendAllowed(input)).resolves.toBeUndefined();
  await expect(assertAutomationSendAllowed({ ...input, message: 'Changed' })).rejects.toThrow('matching saved content');
  await expect(assertAutomationSendAllowed({ ...input, message: undefined })).rejects.toThrow('matching saved content');
});
test('legacy no-message enforces active pause but not unprovable generation staleness', async () => {
  conversation.last_human_reply_at = '2026-01-01T00:30:00Z';
  await expect(assertAutomationSendAllowed({ ...input, message_id: undefined })).resolves.toBeUndefined();
  conversation.automation_paused_until = '2999-01-01T00:00:00Z';
  await expect(assertAutomationSendAllowed({ ...input, message_id: undefined })).rejects.toBeInstanceOf(AutomationSendSuppressed);
});
test('message-only resolution is tenant scoped and scope/read failures fail closed', async () => {
  await assertAutomationSendAllowed({ ...input, conversation_id: undefined });
  expect(filters).toContainEqual(['messages', 'conversations.site_id', 'site']);
  conversation = null;
  await expect(assertAutomationSendAllowed(input)).rejects.toThrow('scope');
  failRead = true;
  await expect(assertAutomationSendAllowed(input)).rejects.toThrow('scope');
});
test('CAS race fails closed without claiming skipped persistence', async () => {
  conversation.automation_paused_until = '2999-01-01T00:00:00Z';
  loseWrite = true;
  await expect(assertAutomationSendAllowed(input)).rejects.toThrow('persist suppressed');
});
test('already sent receipt is not rewritten when suppressing duplicate dispatch', async () => {
  message.custom_data.status = 'sent';
  conversation.automation_paused_until = '2999-01-01T00:00:00Z';
  await expect(assertAutomationSendAllowed(input)).rejects.toBeInstanceOf(AutomationSendSuppressed);
  expect(writes).toHaveLength(0);
});
test('configured tenant schema is used', async () => {
  const previous = process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA;
  process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA = 'apps';
  try { await assertAutomationSendAllowed(input); expect(supabaseAdmin.schema).toHaveBeenCalledWith('apps'); }
  finally { if (previous === undefined) delete process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA; else process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA = previous; }
});