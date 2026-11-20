import { randomUUID, randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { reviewContext, reviewerClient } from '../approval-context';
import { sourceDigest } from '../approval-source';
import type { ApprovalRow, StoredAction } from '../approval-action';

const site = randomUUID(), conversation = randomUUID(), agent = randomUUID(), turn = randomUUID(), instance = randomUUID(), owner = randomUUID();
const row = {site_id:site, conversation_id:conversation, agent_id:agent} as ApprovalRow;
const secret = randomBytes(32).toString('hex');
const content = `Please check my order. Authorization: Bearer ${secret}`;
function conversations(extra: Record<string, unknown> = {}) {
  return { agents:[{site_id: site,id:agent,name:'Shopping team'}], conversations:[{site_id:site,id:conversation,agent_id:agent,title:'Order status'}],
    messages:[{id:turn,command_id:turn,content,role:'user',conversation_id:conversation,agent_id:agent,'conversations.site_id':site,'conversations.agent_id':agent}], ...extra };
}
function client(tables: Record<string, any>) {
  const from = jest.fn((table: string) => {
    let items = [...(tables[table] ?? [])];
    const query = { select: () => query, eq: (key: string, value: unknown) => {items = items.filter(row => row[key] === value); return query;},
      in: (key: string, values: unknown[]) => {items = items.filter(row => values.includes(row[key]));return query;},
      limit: (size: number) => {items = items.slice(0,size);return query;}, abortSignal: () => query,
      maybeSingle: async () => ({data:items.length === 1 ? items[0] : null,error:null}),
      then: (resolve: Function) => resolve({data:items,error:null}) };
    return query;
  });
  return {db:{from} as unknown as SupabaseClient, from};
}
const action = (source?: StoredAction['source']) => ({origin:{kind:'channel_public', lead_id:null},source} as StoredAction);
const screens = { isAdmin:false, blockedScreens:[] };
const exact = {kind:'message' as const,id:turn,digest:sourceDigest(content)};
test.each(['command','message'] as const)('only exact host-bound %s, with bounded redacted fields',async kind => {
  const {db} = client(conversations());
  const context = await reviewContext(db,row,action({...exact,kind}),screens);
  expect(context).toEqual({agent_label:'Shopping team',conversation_title:'Order status',instance_id:null,instance_label:null,
    source_excerpt:'Please check my order. Authorization: [REDACTED]'});
  expect(JSON.stringify(context)).not.toContain(secret);
});
test.each(['unbound','other message','other tenant','reassigned','other role','content edited','ambiguous','unreadable'])('never uses nearby messages (%s)',async reason => {
  const tables = conversations(); const message = tables.messages[0];
  if(reason === 'other message') {message.id = randomUUID();message.command_id = randomUUID();}
  if(reason === 'other tenant') message['conversations.site_id'] = randomUUID();
  if(reason === 'reassigned') message.agent_id = randomUUID();
  if(reason === 'other role') message.role = 'assistant';
  if(reason === 'content edited') message.content = 'Different origin';
  if(reason === 'ambiguous') tables.messages.push({...message,id:randomUUID()});
  if(reason === 'unreadable') tables.conversations = [];
  const {db,from} = client(tables);
  expect((await reviewContext(db,row,action(reason === 'unbound' ? undefined : {...exact,kind:'command'}),screens)).source_excerpt).toBeNull();
  if(['unbound','unreadable'].includes(reason)) expect(from).not.toHaveBeenCalledWith('messages');
});
test.each(['exact','edited','untrusted','other instance','other owner'])('instance: %s',async reason => {
  const {db} = client({remote_instances:[{id:instance,site_id:site,user_id:owner,name:'Operations'}],
    instance_logs:[{id:turn,site_id:site,instance_id:reason === 'other instance' ? randomUUID() : instance,
      user_id:reason === 'other owner' ? randomUUID() : owner, message:reason === 'edited' ? 'Wrong text' : 'Check orders',
      log_type:'user_action',trusted_user_action:reason !== 'untrusted'}]});
  const input = {...action(),origin:{kind:'interactive' as const,instance_id:instance,user_id:owner},
    source:{kind:'instance_log' as const,id:turn,digest:sourceDigest('Check orders')}};
  expect(await reviewContext(db,{...row,conversation_id:null},input,screens)).toEqual({agent_label:'Agent',conversation_title:null,
    instance_id:instance,instance_label:'Operations',source_excerpt:reason === 'exact' ? 'Check orders' : null});
});

test.each(['chat','aiWorkspace'])('hidden source screen %s does not read private context',async key => {
  const {db,from} = client({});
  const input = key === 'chat' ? action(exact) : {...action(),origin:{kind:'interactive' as const,instance_id:instance,user_id:owner}};
  const result = await reviewContext(db,row,input,{isAdmin:false,blockedScreens:[key]});
  expect(result.source_excerpt).toBeNull(); expect(from).not.toHaveBeenCalled();
});

test('all supplemental lookups use the reviewer bearer, not an administrative credential or cached response', async () => {
  const variables = ['NEXT_PUBLIC_SUPABASE_URL','NEXT_PUBLIC_SUPABASE_ANON_KEY'] as const;
  const previous = variables.map(key => process.env[key]);
  const actor = randomBytes(32).toString('hex');
  const anon = randomBytes(32).toString('hex');
  const stub = jest.spyOn(global,'fetch').mockResolvedValue(new Response('[]',{headers:{'Content-Type':'application/json'}}));
  try {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://context.example.test';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = anon;
    const req = new Request('https://example.test');
    expect(reviewerClient(req)).toBeUndefined();
    req.headers.set('authorization',`Bearer ${actor}`);
    const db = reviewerClient(req);
    await reviewContext(db,row,action(exact),screens);
    expect(stub).toHaveBeenCalled();
    for (const [url,init] of stub.mock.calls) {
      const headers = new Headers(init?.headers);
      expect(new URL(String(url)).origin).toBe('https://context.example.test');
      expect(headers.get('authorization')).toBe(`Bearer ${actor}`);
      expect(headers.get('apikey')).toBe(anon); expect(init?.cache).toBe('no-store');
    }
  } finally {
    stub.mockRestore(); variables.forEach((key,i) => {
      if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i];
    });
  }
});
