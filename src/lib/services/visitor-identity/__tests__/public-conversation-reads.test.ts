/** @jest-environment node */
import { PostgrestClient } from '@supabase/postgrest-js';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getConversationsCore } from '@/app/api/agents/customerSupport/conversations/core';
import { getMessagesCore } from '@/app/api/agents/customerSupport/conversations/messages/core';
import { GET as templateStatus } from '@/app/api/agents/tools/templateDeliveryStatus/route';
import { ConversationService } from '@/lib/services/conversation-service';
import { runReportQuery } from '@/app/api/agents/tools/report/query/core';

jest.mock('@/lib/security/site-access', () => ({ canAccessSite: jest.fn(async () => true) }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
const site = '10000000-0000-4000-8000-000000000001';
const thread = '10000000-0000-4000-8000-000000000002';
const visible = '(channel.is.null,channel.neq.internal_review)';
let queries: URL[];
beforeEach(() => {
  queries = [];
  // Exercise the installed PostgREST builder (including embedded table filters)
  // against an offline transport; never contact a database or load credentials.
  const client = new PostgrestClient('https://database.invalid', { fetch: async url => {
    queries.push(new URL(String(url)));
    return Response.json([], { headers: { 'Content-Range': '*/0' } });
  } });
  (supabaseAdmin.from as jest.Mock).mockImplementation(table => client.from(table));
});

it.each([false, true])('filters conversations and counts at the database for summary=%s', async summary_only => {
  await getConversationsCore({ site_id: site, summary_only, channel: 'internal_review', offset: 20 });
  const query = queries[0].searchParams;
  expect(query.get('or')).toBe(visible);
  expect(query.get('site_id')).toBe(`eq.${site}`);
  expect(query.get('channel')).toBe('eq.internal_review');
  expect(query.get('offset')).toBe('20');
});

it('filters site-wide messages via the same inner conversation join used for ownership', async () => {
  await getMessagesCore({ site_id: site, visitor_id: thread });
  const query = queries[0].searchParams;
  expect(query.get('select')).toContain('conversations!inner(');
  expect(query.get('conversations.or')).toBe(visible);
  expect(query.get('conversations.site_id')).toBe(`eq.${site}`);
  expect(query.get('conversations.visitor_id')).toBe(`eq.${thread}`);
  expect(query.get('conversations.lead_id')).toBe('is.null');
});

it('stops a filtered direct lookup before fetching messages or task history', async () => {
  await expect(getMessagesCore({ site_id: site, conversation_id: thread })).rejects.toThrow('NOT_FOUND');
  expect(queries).toHaveLength(1);
  expect(queries[0].pathname).toBe('/conversations');
  expect(queries[0].searchParams.get('id')).toBe(`eq.${thread}`);
  expect(queries[0].searchParams.get('or')).toBe(visible);
});

it('cannot select a review as the latest customer thread or use its messages as model context', async () => {
  await ConversationService.findExistingConversation(undefined, undefined, site);
  await ConversationService.getConversationHistory(thread);
  expect(queries[0].searchParams.getAll('or')).toContain(visible);
  expect(queries[0].searchParams.get('site_id')).toBe(`eq.${site}`);
  expect(queries[1].searchParams.get('select')).toContain('conversations!inner(');
  expect(queries[1].searchParams.get('conversations.or')).toBe(visible);
});

it.each(['conversations', 'messages'] as const)('also excludes private rows from report/query %s counts', async table => {
  const result = await runReportQuery({ table, site_id: site, user_id: thread, count_only: true });
  expect(result.success).toBe(true);
  const query = queries[0].searchParams;
  expect(query.get(table === 'messages' ? 'conversations.or' : 'or')).toBe(visible);
  if (table === 'messages') expect(query.get('select')).toContain('conversations!inner(');
});

it('template status treats a filtered conversation as missing, not a known thread with a missing message', async () => {
  const url = new URL('https://api.invalid/api/agents/tools/templateDeliveryStatus');
  url.search = new URLSearchParams({ site_id: site, conversation_id: thread, message_id: site }).toString();
  const response = await templateStatus(new Request(url));
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ error: 'Conversation not found' });
  expect(queries).toHaveLength(1);
  expect(queries[0].searchParams.get('or')).toBe(visible);
});
