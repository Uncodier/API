import { supabaseAdmin } from '@/lib/database/supabase-client';
import { fetchSiteNameForMerge } from '@/lib/messaging/lead-merge-fields';
import { loadRoutedText, writeRoutedText } from '../routed-text-store';
import { RoutedTextRecipientError } from '../routed-text-identity';
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/messaging/lead-merge-fields', () => ({ ...jest.requireActual('@/lib/messaging/lead-merge-fields'), fetchSiteNameForMerge: jest.fn() }));

const id = { site_id: 'site', conversation_id: 'chat', message_id: 'saved' };
const rows: Record<string, any[]> = {};
let history: any[];
let historyError: unknown;
const reads: Array<[string, string, unknown]> = [];
let writeFilters: Array<[string, unknown]>;
beforeEach(() => {
  jest.clearAllMocks(); reads.length = 0; writeFilters = []; history = []; historyError = null;
  rows.messages = [{ id: 'saved', conversation_id: 'chat', content: 'Hello {{name}}!', role: 'team_member', custom_data: { status: 'pending' } }];
  rows.conversations = [{ id: 'chat', site_id: 'site', channel: 'whatsapp', visitor_id: 'visitor', lead_id: 'lead', custom_data: {} }];
  rows.leads = [{ id: 'lead', site_id: 'site', phone: '+15555550101', name: 'Ada' }];
  // Production visitors are global: only leads, sessions and segments have site_id.
  rows.visitors = [{ id: 'visitor', lead_id: 'lead', custom_data: { whatsapp_phone: '+15555550101' } }];
  rows.visitor_sessions = [{ visitor_id: 'visitor', site_id: 'site' }];
  rows.segments = [];
  (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
    const filters: Array<[string, unknown]> = []; let write = false;
    let selection = '';
    const stmt = { select: (columns: string) => { selection = columns; return stmt; }, update: () => { write = true; return stmt; },
      eq: (k: string, v: unknown) => { filters.push([k,v]); reads.push([table,k,v]); return stmt; }, in: (k: string, v: unknown) => { reads.push([table,k,v]); return stmt; }, order: () => stmt,
      limit: async () => ({ data: history, error: historyError }),
      maybeSingle: async () => {
        if (write) { writeFilters = filters; return { data: { id: 'saved' }, error: null }; }
        if (table === 'visitors' && filters.some(([k]) => k === 'site_id')) {
          return { data: null, error: { code: '42703' } };
        }
        return { data: rows[table]?.find(row => filters.every(([k,v]) => {
          if (k === 'visitor_sessions.site_id') return selection.includes('visitor_sessions!inner(')
            && rows.visitor_sessions.some(s => s.visitor_id === row.id && s.site_id === v);
          if (k === 'segments.site_id') return selection.includes('segments!inner(')
            && rows.segments.some(s => s.id === row.segment_id && s.site_id === v);
          return row[k] === v;
        })) || null, error: null };
      } };
    return stmt;
  });
});

it('loads the real saved message, scoped lead/visitor and complete text, never a caller recipient', async () => {
  const result = await loadRoutedText(id);
  expect(result).toMatchObject({ text: 'Hello Ada!', recipient: '+15555550101', content: 'Hello {{name}}!' });
  expect(fetchSiteNameForMerge).toHaveBeenCalledWith('site');
  expect(reads).toEqual(expect.arrayContaining([['visitors','lead_id','lead'], ['leads','site_id','site'],
    ['conversations','site_id','site'], ['messages','conversations.site_id','site'], ['messages','conversation_id','chat'], ['messages','role',['user','visitor']]]));
  await writeRoutedText(id, result, result.metadata, { status: 'placement_unknown' });
  expect(writeFilters).toEqual(expect.arrayContaining([['id','saved'],['conversation_id','chat'],['role','team_member'],
    ['content','Hello {{name}}!'], ['custom_data',JSON.stringify(result.metadata)]]));
});

it.each(['session', 'segment'])('loads a visitor-only chat through its scoped %s, never through a global phone lookup', async scope => {
  rows.conversations[0].lead_id = null; rows.messages[0].content = 'Hello';
  rows.visitors[0].lead_id = null;
  if (scope === 'segment') {
    rows.visitor_sessions[0].site_id = 'other'; rows.visitors[0].segment_id = 'segment';
    rows.segments.push({ id: 'segment', site_id: 'site' });
  }
  expect((await loadRoutedText(id)).recipient).toBe('+15555550101');
  expect(reads).toContainEqual(['visitors', scope === 'segment' ? 'segments.site_id' : 'visitor_sessions.site_id', 'site']);
  expect(reads).not.toContainEqual(['visitors', 'site_id', 'site']);
});

it('never uses an unscoped visitor, even when a foreign session or segment supplies a valid number', async () => {
  rows.visitors[0].lead_id = null; rows.visitor_sessions[0].site_id = 'other';
  rows.visitors[0].segment_id = 'segment'; rows.segments.push({ id: 'segment', site_id: 'other' });
  await expect(loadRoutedText(id)).rejects.toThrow('visitor unavailable');
});

it('a visitor linked to a different lead is not a recipient for this contact', async () => {
  rows.visitors[0].lead_id = 'different';
  await expect(loadRoutedText(id)).rejects.toBeInstanceOf(RoutedTextRecipientError);
});

it.each(['internal_review','email'])('refuses a non-WhatsApp thread (%s)', async channel => {
  rows.conversations[0].channel = channel;
  await expect(loadRoutedText(id)).rejects.toThrow();
});
it('does not trust a foreign lead or conversation', async () => {
  await expect(loadRoutedText({ ...id, site_id: 'other' })).rejects.toThrow();
  rows.leads[0].site_id = 'other';
  await expect(loadRoutedText(id)).rejects.toThrow();
});
it.each([{ response_format: 'audio' }, { media_url: 'attachment' }, { origin_message_id: 'turn' }, { outreach_activity: 'managed' }])(
  'does not take over other dispatch types %j', async extra => {
    Object.assign(rows.messages[0].custom_data, extra);
    await expect(loadRoutedText(id)).rejects.toThrow();
  });
const inbound = (from: string) => ({ id: 'turn', lead_id: 'lead', created_at: '2026-11-20T12:00:00Z',
  custom_data: { source: 'zavu_inbound_message', channel: 'whatsapp', origin_message_id: 'event',
    connection_id: 'z', zavu_sender_id: 'sender', zavu_from: from } });

it.each(['14155550100', '+14155550100', 'whatsapp:14155550100', 'whatsapp:+14155550100'])(
  'derives the exact scoped provider contact (%s), without guessing a country', async from => {
    history.push(inbound(from));
    rows.leads[0].phone = '14155550100';
    delete rows.visitors[0].custom_data.whatsapp_phone;
    await expect(loadRoutedText(id)).resolves.toMatchObject({ recipient: '+14155550100' });
    delete rows.conversations[0].visitor_id;
    delete rows.conversations[0].lead_id;
    rows.messages[0].content = 'Hello';
    await expect(loadRoutedText(id)).resolves.toMatchObject({ recipient: '+14155550100' });
  });

it.each(['4155550100', '14155550100', '415 555-0100', '+14155550100 ext 23', '0014155550100'])(
  'cannot rescue or guess an unverified local/contact value (%s)', async phone => {
    rows.leads[0].phone = phone; delete rows.conversations[0].visitor_id;
    await expect(loadRoutedText(id)).rejects.toMatchObject({ snapshot: {
      role: 'team_member', content: rows.messages[0].content, metadata: { status: 'pending' },
    } });
  });

it('does not promote forwarded/outbound hints to recipient authority', async () => {
  rows.leads[0].phone = '14155550100'; delete rows.conversations[0].visitor_id;
  Object.assign(rows.messages[0].custom_data, { whatsapp_phone: '+14155550100' });
  history.push({ custom_data: { from: '+14155550100', whatsapp_phone: '+14155550100', provider: 'twilio' } });
  await expect(loadRoutedText(id)).rejects.toBeInstanceOf(RoutedTextRecipientError);
});

it('retains explicit formatted international contacts without altering any digit', async () => {
  rows.leads[0].phone = '+52 (1) 555-555-0100'; delete rows.conversations[0].visitor_id;
  await expect(loadRoutedText(id)).resolves.toMatchObject({ recipient: '+5215555550100' });
});

it.each(['lead-vs-visitor','inbound-vs-contact','inbound-vs-inbound','lead-id','visitor-id','history-lead-id'])(
  'rejects a conflicting customer identity (%s)', async scenario => {
    history.push(inbound('+15555550101'));
    if (scenario === 'lead-vs-visitor') rows.leads[0].phone = '+15555550109';
    if (scenario === 'inbound-vs-contact') history[0].custom_data.zavu_from = '+15555550109';
    if (scenario === 'inbound-vs-inbound') history.push(inbound('+15555550109'));
    if (scenario === 'lead-id') { rows.messages[0].lead_id = 'different'; rows.leads.push({ ...rows.leads[0], id: 'different' }); }
    if (scenario === 'visitor-id') rows.messages[0].visitor_id = 'different';
    if (scenario === 'history-lead-id') history[0].lead_id = 'different';
    await expect(loadRoutedText(id)).rejects.toBeInstanceOf(RoutedTextRecipientError);
  });

it.each(['unavailable','truncated'])('incomplete history is not a permanent recipient failure (%s)', async reason => {
  if (reason === 'truncated') history = Array(1000).fill(inbound('+15555550101'));
  else historyError = { code: 'timeout' };
  await expect(loadRoutedText(id)).rejects.toThrow('history unavailable');
});
