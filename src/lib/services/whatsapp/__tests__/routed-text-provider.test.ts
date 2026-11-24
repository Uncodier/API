import { randomBytes } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { licensedRpcResult } from '@/lib/messaging/__tests__/licensed-rpc-fixture';
import { AutomationSendSuppressed } from '@/lib/services/channels/automation-send-guard';
import { attemptRoutedText, type RoutedTextResult, type TextRoute, type TextTemplate } from '../routed-text-provider';
import { sendRoutedText } from '../routed-text';
import { loadRoutedText, writeRoutedText, type RoutedContext } from '../routed-text-store';

// Real credential selection, template clients, live license projection parsing,
// approval parsing and message transports. Only DB and HTTP I/O are replaced.
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc: jest.fn(), from: jest.fn(), schema: jest.fn() } }));
jest.mock('../routed-text-store', () => ({ loadRoutedText: jest.fn(), writeRoutedText: jest.fn() }));
type Row = Record<string, any>;
type Input = Parameters<typeof attemptRoutedText>[0];
const hex = () => randomBytes(16).toString('hex');
const account = `AC${hex()}`, otherAccount = `AC${hex()}`, token = hex(), otherToken = hex();
const service = `MG${hex()}`, hSid = `HX${hex()}`, smSid = `SM${hex()}`, zKey = hex();
const from = '+524611051101', recipient = '+15555550102';
const zRoute: TextRoute = { connectionId: 'chosen', provider: 'zavu', sender: 'sender_chosen' };
const tRoute: TextRoute = { connectionId: 'legacy:whatsapp', provider: 'twilio', sender: JSON.stringify([account, from]) };
const body = ' Áda,  aquí está tu respuesta.\n**Gracias** 👩‍💻  ';
const verify = jest.fn(async () => { events.push('verify'); });
const input = (route: TextRoute = zRoute, changes: Partial<Input> = {}): Input => ({
  siteId: 'site', conversationId: 'chat', messageId: 'saved', recipient, text: body, route,
  forceTemplate: false, verifyBinding: verify, ...changes,
});
const contentUrl = 'https://content.twilio.com/v1/Content';
const tSend = `https://api.twilio.com/2010-04-01/Accounts/${account}/Messages.json`;
const zApi = 'https://api.zavu.dev/v1', zSend = `${zApi}/messages`;
const net = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
const rpc = supabaseAdmin.rpc as jest.Mock, db = supabaseAdmin.from as jest.Mock;
const json = (obj: unknown, status = 200) => Response.json(obj, { status });
const disconnected = { code: 'channel_not_connected', details: { channel: 'whatsapp' } };
const accepted = (url: string) => url === zSend ? json({ message: { id: 'msg_z', status: 'queued' } }) : json({ sid: smSid, status: 'queued' });
const calls = () => net.mock.calls.map(([url, init]) => ({ url: String(url), method: init?.method ?? 'GET',
  headers: new Headers(init?.headers), body: String(init?.body || ''), signal: init?.signal }));
const urls = () => calls().map(c => `${c.method} ${c.url}`);
const jsonBody = (i: number) => JSON.parse(calls()[i].body);
const oldFetch = global.fetch, oldKey = process.env.ZAVUDEV_API_KEY;
let channels: { connections: Row[]; whatsapp: Row; agent_whatsapp: Row };
let tables: Record<string, Row[]>, errors: Set<string>, events: string[];
let zTemplate: Row, tTemplate: Row, approval: string;
let unexpected: string[];

function memoryQuery(table: string) {
  if (!(table in tables)) throw new Error('Unexpected table');
  const filters: ((r: Row) => boolean)[] = [];
  let added: Row | undefined;
  const result = () => {
    if (errors.has(table)) return { data: null, error: { message: token } };
    if (added) tables[table].push(added);
    return { data: tables[table].filter(r => filters.every(f => f(r))), error: null };
  };
  const q = { select: () => q, eq: (k: string, v: unknown) => { filters.push(r => r[k] === v); return q; },
    in: (k: string, values: string[]) => { filters.push(r => values.includes(r[k])); return q; },
    order: () => q, limit: () => q, abortSignal: () => q,
    insert: (r: Row) => { added = r; return q; },
    maybeSingle: async () => { const r = result(); return { data: r.data?.[0] ?? null, error: r.error }; },
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve) };
  return q;
}
async function remote(url: Parameters<typeof fetch>[0], init?: RequestInit) {
  const u = String(url), method = init?.method || 'GET';
  const payload = () => JSON.parse(String(init?.body));
  events.push(`${method} ${u}`);
  if ((u === zSend || u === tSend) && method === 'POST') return accepted(u);
  if (u === `${zApi}/templates` && method === 'POST') {
    zTemplate = { id: 'tpl_z', status: 'draft', ...payload() }; return json({ template: zTemplate });
  }
  if (u === `${zApi}/templates/tpl_z/submit` && method === 'POST') { zTemplate.status = 'pending'; return json(zTemplate); }
  if (u === `${zApi}/templates/tpl_z` && method === 'GET') return json(zTemplate);
  if (u === contentUrl && method === 'POST') {
    tTemplate = { sid: hSid, account_sid: account, ...payload() }; return json(tTemplate, 201);
  }
  if (u === `${contentUrl}/${hSid}/ApprovalRequests/whatsapp` && method === 'POST') return json({ status: 'received' }, 201);
  if (u === `${contentUrl}/${hSid}` && method === 'GET') return json(tTemplate);
  if (u === `${contentUrl}/${hSid}/ApprovalRequests` && method === 'GET') return json({ whatsapp: { status: approval } });
  unexpected.push(`${method} ${u}`); throw new Error('Unmocked HTTP target');
}

beforeEach(() => {
  jest.resetAllMocks();
  events = []; unexpected = []; errors = new Set();
  verify.mockImplementation(async () => { events.push('verify'); });
  channels = { connections: [ { id: 'other', type: 'whatsapp', status: 'connected', zavu_sender_id: 'sender_other' },
    { id: 'chosen', type: 'whatsapp', status: 'connected', zavu_sender_id: zRoute.sender } ],
    whatsapp: { status: 'active', account_sid: account, existingNumber: from, access_token: token, messaging_service_sid: service },
    agent_whatsapp: { status: 'active', account_sid: otherAccount, existingNumber: from, access_token: otherToken } };
  tables = { settings: [{ site_id: 'site', default_locale: 'es-MX' }], secure_tokens: [], whatsapp_templates: [] };
  tTemplate = { sid: hSid, account_sid: account, language: 'es_MX', friendly_name: 'saved_reply', types: { 'twilio/text': { body } } };
  zTemplate = {}; approval = 'pending';
  db.mockImplementation(memoryQuery);
  rpc.mockImplementation(() => { events.push('license'); return licensedRpcResult(channels); });
  process.env.ZAVUDEV_API_KEY = zKey;
  global.fetch = net.mockImplementation(remote);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  global.fetch = oldFetch;
  if (oldKey === undefined) delete process.env.ZAVUDEV_API_KEY; else process.env.ZAVUDEV_API_KEY = oldKey;
  jest.restoreAllMocks(); jest.useRealTimers();
  expect(unexpected).toEqual([]);
});
async function submitted(route: TextRoute): Promise<TextTemplate> {
  const result = await attemptRoutedText(input(route, { forceTemplate: true }));
  expect(result.kind).toBe('pending');
  if (result.kind !== 'pending') throw new Error('Expected a pending template');
  return result.template;
}
function expectSafe(result: RoutedTextResult, kind: string) {
  expect(result.kind).toBe(kind);
  for (const value of [token, otherToken, zKey, body, recipient]) expect(JSON.stringify(result)).not.toContain(value);
}

it.each([zRoute, tRoute])('sends literal in-window text once on the exact $provider route', async route => {
  const z = route.provider === 'zavu';
  expect(await attemptRoutedText(input(route))).toEqual({ kind: 'accepted', providerMessageId: z ? 'msg_z' : smSid });
  expect(events).toEqual(['license', 'verify', `POST ${z ? zSend : tSend}`]);
  expect(rpc).toHaveBeenCalledWith('get_site_licensed_resources', { p_site_id: 'site' });
  expect(db).not.toHaveBeenCalled();
  const c = calls()[0];
  if (z) {
    expect(c.headers.get('Zavu-Sender')).toBe(zRoute.sender); expect(c.headers.get('Authorization')).toBe(`Bearer ${zKey}`);
    expect(c.signal).toBeDefined();
    expect(jsonBody(0)).toEqual({ to: recipient, channel: 'whatsapp', text: body, idempotencyKey: expect.any(String) });
  } else {
    expect(c.headers.get('Authorization')).toBe(`Basic ${Buffer.from(`${account}:${token}`).toString('base64')}`);
    expect(Object.fromEntries(new URLSearchParams(c.body))).toEqual({ To: `whatsapp:${recipient}`, From: `whatsapp:${from}`,
      MessagingServiceSid: service, Body: body });
  }
});

it('Zavu: creates the site-language literal, submits to the pinned sender once, polls the same ID and dispatches only on approval', async () => {
  const ref = await submitted(zRoute);
  expect(ref).toEqual({ id: 'tpl_z', language: 'es_MX', name: expect.stringMatching(/^routed_reply_[a-f0-9]+$/) });
  expect(jsonBody(0)).toEqual({ name: ref.name, language: 'es_MX', body, variables: [], whatsappCategory: 'UTILITY' });
  expect(jsonBody(1)).toEqual({ senderId: zRoute.sender, category: 'UTILITY' });
  expect(events).toEqual(['license', 'verify', `POST ${zApi}/templates`, 'license', 'verify', `POST ${zApi}/templates/tpl_z/submit`]);
  const poll = () => attemptRoutedText(input(zRoute, { template: ref, forceTemplate: false }));
  errors.add('settings'); tables.settings[0].default_locale = 'fr';
  zTemplate.status = 'draft'; expect(await poll()).toEqual({ kind: 'pending', template: ref });
  zTemplate.status = 'approved'; zTemplate.whatsapp = { status: 'PENDING' };
  expect(await poll()).toEqual({ kind: 'pending', template: ref });
  zTemplate.whatsapp.status = 'APPROVED';
  expect(await poll()).toEqual({ kind: 'accepted', providerMessageId: 'msg_z' });
  expect(urls()).toEqual([`POST ${zApi}/templates`, `POST ${zApi}/templates/tpl_z/submit`, ...Array(3).fill(`GET ${zApi}/templates/tpl_z`), `POST ${zSend}`]);
  expect(events.slice(-3)).toEqual(['license', 'verify', `POST ${zSend}`]);
  expect(calls()[5].headers.get('Zavu-Sender')).toBe(zRoute.sender);
  expect(jsonBody(5)).toEqual({ to: recipient, channel: 'whatsapp', messageType: 'template', content: { templateId: ref.id }, idempotencyKey: expect.any(String) });
});

it('Twilio: ignores fuzzy/foreign/wrong-language catalog rows; creates and submits once, GETs the exact SID and approval, then sends only ContentSid', async () => {
  const row = { site_id: 'site', account_sid: account, status: 'active', language: 'es_MX', templated_body: body,
    template_sid: `HX${hex()}`, template_name: 'wrong' };
  tables.whatsapp_templates.push({ ...row, site_id: 'foreign' }, { ...row, account_sid: otherAccount },
    { ...row, language: 'es' }, { ...row, templated_body: body.trim() }, { ...row, status: 'rejected' });
  const ref = await submitted(tRoute);
  expect(ref).toEqual({ id: hSid, name: tTemplate.friendly_name, language: 'es_MX' });
  expect(jsonBody(0)).toEqual({ friendly_name: ref.name, language: 'es_MX', types: { 'twilio/text': { body } } });
  expect(jsonBody(1)).toEqual({ name: ref.name, category: 'UTILITY' });
  expect(tables.whatsapp_templates.at(-1)).toMatchObject({ template_sid: hSid, site_id: 'site', account_sid: account,
    templated_body: body, language: ref.language, status: 'pending', placeholder_map: [] });
  expect(await attemptRoutedText(input(tRoute, { template: ref }))).toEqual({ kind: 'pending', template: ref });
  approval = 'approved'; errors.add('settings'); errors.add('whatsapp_templates');
  expect(await attemptRoutedText(input(tRoute, { template: ref }))).toEqual({ kind: 'accepted', providerMessageId: smSid });
  expect(urls()).toEqual([`POST ${contentUrl}`, `POST ${contentUrl}/${hSid}/ApprovalRequests/whatsapp`,
    `GET ${contentUrl}/${hSid}`, `GET ${contentUrl}/${hSid}/ApprovalRequests`,
    `GET ${contentUrl}/${hSid}`, `GET ${contentUrl}/${hSid}/ApprovalRequests`, `POST ${tSend}`]);
  for (const c of calls()) expect(c.headers.get('Authorization')).toBe(`Basic ${Buffer.from(`${account}:${token}`).toString('base64')}`);
  for (const [i, event] of events.entries()) if (event.startsWith('POST ')) expect(events.slice(i - 2, i)).toEqual(['license', 'verify']);
  expect(Object.fromEntries(new URLSearchParams(calls()[6].body))).toEqual({ From: `whatsapp:${from}`, To: `whatsapp:${recipient}`,
    MessagingServiceSid: service, ContentSid: hSid });
});

it('Twilio: reuses an exact existing account template only after checking actual content and approval', async () => {
  approval = 'approved';
  tables.whatsapp_templates.push({ site_id: 'site', account_sid: account, language: 'es_MX', status: 'active', templated_body: body,
    template_sid: hSid, template_name: tTemplate.friendly_name });
  expect(await attemptRoutedText(input(tRoute, { forceTemplate: true }))).toEqual({ kind: 'accepted', providerMessageId: smSid });
  expect(urls()).toEqual([`GET ${contentUrl}/${hSid}`, `GET ${contentUrl}/${hSid}/ApprovalRequests`, `POST ${tSend}`]);
});

it.each([['foreign account', { account_sid: otherAccount }], ['different ID', { sid: `HX${hex()}` }],
  ['language', { language: 'es' }], ['modified text', { types: { 'twilio/text': { body: body.trim() } } }],
  ['non-text variant', { types: { 'twilio/text': { body }, 'twilio/media': { body } } }]] as const)(
  'Twilio refuses %s in a returned Content resource, even with an otherwise approved SID', async (_label, change) => {
    Object.assign(tTemplate, change); approval = 'approved';
    expectSafe(await attemptRoutedText(input(tRoute, { template: { id: hSid } })), 'failed');
    expect(urls()).toEqual([`GET ${contentUrl}/${hSid}`]);
  });

it.each(['rejected', 'paused', 'disabled'])('Twilio: %s approval is terminal and never permits freeform/fallback', async status => {
  approval = status;
  expectSafe(await attemptRoutedText(input(tRoute, { template: { id: hSid } })), 'failed');
  expect(urls()).toEqual([`GET ${contentUrl}/${hSid}`, `GET ${contentUrl}/${hSid}/ApprovalRequests`]);
});
it.each([{ id: 'another' }, { language: 'fr' }, { body: body.normalize('NFC') }, { name: 'unbound' },
  { whatsapp: { status: 'REJECTED' } }, { status: 'rejected' }])('Zavu refuses mismatched or rejected pinned data (%#)', async change => {
  const ref = await submitted(zRoute); zTemplate.status = 'approved'; Object.assign(zTemplate, change);
  expectSafe(await attemptRoutedText(input(zRoute, { template: ref })), 'failed');
  expect(urls().at(-1)).toBe(`GET ${zApi}/templates/tpl_z`); expect(net).toHaveBeenCalledTimes(3);
});
it('Zavu cannot reuse a project-scoped approval submitted to another sender, even with the same body', async () => {
  const ref = await submitted(zRoute); zTemplate.status = 'approved';
  const other: TextRoute = { connectionId: 'other', sender: 'sender_other', provider: 'zavu' };
  expectSafe(await attemptRoutedText(input(other, { template: { id: ref.id, language: ref.language } })), 'failed');
  expect(net).toHaveBeenCalledTimes(3);
});

it.each([zRoute, tRoute])('$provider polls only its saved ID on a transient read; missing template is not a sender denial', async route => {
  const ref = await submitted(route); net.mockClear();
  const poll = () => attemptRoutedText(input(route, { template: ref }));
  net.mockResolvedValueOnce(json({ error: token }, 503));
  expect(await poll()).toEqual({ kind: 'pending', template: ref });
  net.mockResolvedValueOnce(json({ error: token }, 404)); expectSafe(await poll(), 'failed');
  const get = route.provider === 'twilio' ? `${contentUrl}/${ref.id}` : `${zApi}/templates/${ref.id}`;
  expect(urls()).toEqual([`GET ${get}`, `GET ${get}`]);
});
it.each([zRoute, tRoute])('$provider does not retry an ambiguous creation or approval submission', async route => {
  net.mockRejectedValueOnce(new Error(token));
  expectSafe(await attemptRoutedText(input(route, { forceTemplate: true })), 'unknown');
  expect(net).toHaveBeenCalledTimes(1); net.mockClear();
  net.mockImplementationOnce(remote).mockRejectedValueOnce(new Error(otherToken));
  expectSafe(await attemptRoutedText(input(route, { forceTemplate: true })), 'unknown');
  expect(net).toHaveBeenCalledTimes(2);
  expect(urls()).not.toContain(`POST ${tSend}`); expect(urls()).not.toContain(`POST ${zSend}`);
});

it.each([[400, 63007, 'unavailable'], [400, 63003, 'failed'], [400, 63016, 'failed'], [400, 63024, 'failed'],
  [502, 20500, 'unknown'], [502, 63007, 'unknown'], [502, undefined, 'unknown']] as const)(
  'Twilio HTTP %i/code %s is %s, with one pinned From and no other provider', async (status, code, kind) => {
    delete channels.whatsapp.messaging_service_sid; // The non-strict path would try the +521 alias on 63007.
    net.mockResolvedValueOnce(json({ status, message: `${token} ${recipient}`, code }, status));
    expectSafe(await attemptRoutedText(input(tRoute)), kind);
    expect(urls()).toEqual([`POST ${tSend}`]);
    expect(new URLSearchParams(calls()[0].body).get('From')).toBe(`whatsapp:${from}`);
  });
it.each([[400, 'failed'], [403, 'failed'], [404, 'failed'], [409, 'unknown'], [422, 'failed'], [503, 'unknown']] as const)(
  'Zavu HTTP %i never grants route advance from a generic/undocumented error', async (status, kind) => {
    net.mockResolvedValueOnce(json({ error: `Sender not found: ${token}`, code: 'UNDOCUMENTED' }, status));
    expectSafe(await attemptRoutedText(input()), kind);
    expect(urls()).toEqual([`POST ${zSend}`]);
  });
it.each(['text', 'template'] as const)('Zavu: an explicit WhatsApp disconnection on the %s message POST is unavailable', async mode => {
  const template = mode === 'template' ? await submitted(zRoute) : undefined;
  zTemplate.status = 'approved'; net.mockClear();
  if (template) net.mockImplementationOnce(remote); // The pinned approval GET is not the failed send.
  net.mockResolvedValueOnce(json({ ...disconnected, error: `${zKey} ${recipient}` }, 409));
  expectSafe(await attemptRoutedText(input(zRoute, { template })), 'unavailable');
  expect(urls()).toEqual([...(template ? [`GET ${zApi}/templates/${template.id}`] : []), `POST ${zSend}`]);
  const send = calls().at(-1)!;
  expect(send.headers.get('Zavu-Sender')).toBe(zRoute.sender);
  expect(JSON.parse(send.body)).toMatchObject({ channel: 'whatsapp', to: recipient,
    ...(template ? { messageType: 'template', content: { templateId: template.id } } : { text: body }) });
});
it('Zavu: a structured error with its own explicit code and channel also proves non-placement', async () => {
  net.mockResolvedValueOnce(json({ error: { ...disconnected, message: token } }, 409));
  expectSafe(await attemptRoutedText(input()), 'unavailable');
  expect(urls()).toEqual([`POST ${zSend}`]);
});
it.each([
  ['wrong HTTP status', 503, disconnected], ['request rejection', 400, disconnected],
  ['absent details.channel', 409, { code: disconnected.code, channel: 'whatsapp' }],
  ['different channel', 409, { ...disconnected, details: { channel: 'sms' } }],
  ['invalid channel', 409, { ...disconnected, details: { channel: [token] } }],
  ['conflicting channels', 409, { ...disconnected, channel: 'telegram' }],
  ['conflicting codes', 409, { ...disconnected, error: { code: 'idempotency_conflict' } }],
  ['freeform error instead of code', 409, { details: disconnected.details, error: disconnected.code }],
  ['message status without ID', 409, { ...disconnected, message: { status: 'queued' } }],
  ['message ID without status', 409, { ...disconnected, message: { id: 'prior' } }],
  ['top-level placement', 409, { ...disconnected, messageId: 'prior' }],
  ['top-level status', 409, { ...disconnected, status: 'delivered' }],
  ['nested receipt', 409, { ...disconnected, details: { ...disconnected.details, receipt: { id: 'prior' } } }],
  ['replay marker', 409, { ...disconnected, replayed: true }],
  ['contradictory success', 409, { ...disconnected, success: true }],
] as const)('Zavu: %s cannot prove sender non-placement', async (_label, status, payload) => {
  net.mockResolvedValueOnce(json(payload, status));
  expectSafe(await attemptRoutedText(input()), status === 400 ? 'failed' : 'unknown');
  expect(urls()).toEqual([`POST ${zSend}`]);
});
it('Zavu: redirects and transport exceptions resembling the documented body are not first-party refusals', async () => {
  const redirected = json(disconnected, 409);
  Object.defineProperties(redirected, { redirected: { value: true }, url: { value: 'https://other.example.invalid/messages' } });
  net.mockResolvedValueOnce(redirected).mockRejectedValueOnce(Object.assign(new Error(token), { status: 409, ...disconnected }));
  expectSafe(await attemptRoutedText(input()), 'unknown');
  expectSafe(await attemptRoutedText(input()), 'unknown');
  expect(urls()).toEqual([`POST ${zSend}`, `POST ${zSend}`]);
});
it.each(['create', 'submit'] as const)('Zavu: 409 channel_not_connected at template %s never grants route advance', async op => {
  if (op === 'submit') net.mockImplementationOnce(remote);
  net.mockResolvedValueOnce(json(disconnected, 409));
  expectSafe(await attemptRoutedText(input(zRoute, { forceTemplate: true })), 'unknown');
  expect(urls()).toEqual([`POST ${zApi}/templates`, ...(op === 'submit' ? [`POST ${zApi}/templates/tpl_z/submit`] : [])]);
});
it.each([[{}, 'unknown'], [{ message: { id: 'x' } }, 'unknown'], [{ message: { id: 'unknown', status: 'sent' } }, 'unknown'],
  [{ message: { id: 'failed-id', status: 'failed' } }, 'failed'], [{ success: false, message: { id: 'x', status: 'queued' } }, 'unknown']] as const)(
  'Zavu requires real acceptance evidence (%#)', async (result, kind) => {
    net.mockResolvedValueOnce(json(result)); expectSafe(await attemptRoutedText(input()), kind); expect(net).toHaveBeenCalledTimes(1);
  });
it.each([{}, disconnected])('Zavu treats an idempotent 409 with an accepted provider message as that one acceptance (%#)', async extra => {
  net.mockResolvedValueOnce(json({ ...extra, message: { id: 'prior', status: 'delivered' } }, 409));
  expect(await attemptRoutedText(input())).toEqual({ kind: 'accepted', providerMessageId: 'prior' });
  expect(urls()).toEqual([`POST ${zSend}`]);
});
it('routes one unbound Zavu disconnection to a fresh Twilio approval, then replays the saved acceptance without another POST', async () => {
  // In-memory saved context/CAS + I/O fixtures. Router, guard, inventory,
  // provider adapters and both HTTP clients are real, including across polls.
  channels.connections = [channels.connections[1]];
  const id = { site_id: 'site', conversation_id: 'chat', message_id: 'saved' };
  const ctx: RoutedContext = { role: 'team_member', content: body, text: body, recipient,
    metadata: { status: 'sending' }, conversation: {}, inbound: [] };
  jest.mocked(loadRoutedText).mockImplementation(async () => structuredClone(ctx));
  jest.mocked(writeRoutedText).mockImplementation(async (_, _ctx, previous, next) => {
    if (JSON.stringify(ctx.metadata) !== JSON.stringify(previous)) throw new Error('Lost receipt ownership');
    ctx.metadata = JSON.parse(JSON.stringify(next));
  });
  tables.conversations = [{ id: id.conversation_id, site_id: id.site_id, channel: 'whatsapp' }];
  tables.messages = [{ id: id.message_id, conversation_id: id.conversation_id, role: ctx.role, content: ctx.content }];
  (supabaseAdmin.schema as jest.Mock).mockReturnValue({ from: db });
  net.mockImplementation(async (url, init) => String(url) === zSend
    ? json({ ...disconnected, message: token }, 409) : remote(url, init));

  expect(await sendRoutedText(id)).toMatchObject({ status: 'template_pending', provider: 'zavu', template_id: 'tpl_z' });
  zTemplate.status = 'approved';
  expect(await sendRoutedText(id)).toMatchObject({ status: 'template_pending', provider: 'twilio', template_id: hSid });
  expect(ctx.metadata.whatsapp_text_delivery.refused).toEqual([{ connection_id: zRoute.connectionId, reason: expect.any(String) }]);
  expect(JSON.stringify(ctx.metadata)).not.toContain(token);
  approval = 'approved';
  for (let i = 0; i < 2; i++) expect(await sendRoutedText(id)).toMatchObject({ status: 'accepted',
    connection_id: tRoute.connectionId, provider: 'twilio', provider_message_id: smSid });
  expect(urls()).toEqual([`POST ${zApi}/templates`, `POST ${zApi}/templates/tpl_z/submit`, `GET ${zApi}/templates/tpl_z`, `POST ${zSend}`,
    `POST ${contentUrl}`, `POST ${contentUrl}/${hSid}/ApprovalRequests/whatsapp`, `GET ${contentUrl}/${hSid}`,
    `GET ${contentUrl}/${hSid}/ApprovalRequests`, `POST ${tSend}`]);
  expect(calls()[3].headers.get('Zavu-Sender')).toBe(zRoute.sender);
  expect(jsonBody(3)).toMatchObject({ to: recipient, channel: 'whatsapp', content: { templateId: 'tpl_z' } });
  const fallback = new URLSearchParams(calls().at(-1)!.body);
  expect(Object.fromEntries(fallback)).toMatchObject({ From: `whatsapp:${from}`, To: `whatsapp:${recipient}`, ContentSid: hSid });
  expect(fallback.has('Body')).toBe(false);
});
it.each([undefined, ' ', 'unknown', 'saved'])('Twilio 2xx without a credible provider ID (%s) is unknown', async sid => {
  net.mockResolvedValueOnce(json({ sid })); expectSafe(await attemptRoutedText(input(tRoute)), 'unknown'); expect(net).toHaveBeenCalledTimes(1);
});

it.each([zRoute, tRoute])('$provider: absent credentials are unavailable; an inventory outage is not', async route => {
  delete process.env.ZAVUDEV_API_KEY; delete channels.whatsapp.access_token;
  // Another site's (or another provider's) account cannot supply a token.
  tables.secure_tokens.push({ site_id: 'other-site', token_type: 'twilio_whatsapp', identifier: from, value: otherToken });
  expectSafe(await attemptRoutedText(input(route)), 'unavailable');
  rpc.mockImplementationOnce(() => { throw new Error(token); });
  expectSafe(await attemptRoutedText(input(route)), 'failed');
  expect(net).not.toHaveBeenCalled();
});
it('Twilio token/catalog lookup failures are never mistaken for missing credentials / no existing template', async () => {
  delete channels.whatsapp.access_token; errors.add('secure_tokens');
  expectSafe(await attemptRoutedText(input(tRoute)), 'failed');
  channels.whatsapp.access_token = token; errors.add('whatsapp_templates');
  expectSafe(await attemptRoutedText(input(tRoute, { forceTemplate: true })), 'failed');
  expect(net).not.toHaveBeenCalled();
});
it('Twilio refuses a different account even when the From number matches', async () => {
  channels.whatsapp.account_sid = otherAccount;
  expectSafe(await attemptRoutedText(input(tRoute)), 'failed'); expect(net).not.toHaveBeenCalled();
});
it('Twilio resolves the selected agent account, not the other legacy row with the same number', async () => {
  const agent: TextRoute = { ...tRoute, connectionId: 'legacy:agent_whatsapp', sender: JSON.stringify([otherAccount, from]) };
  net.mockResolvedValueOnce(json({ sid: smSid }));
  expect(await attemptRoutedText(input(agent))).toEqual({ kind: 'accepted', providerMessageId: smSid });
  expect(urls()).toEqual([`POST https://api.twilio.com/2010-04-01/Accounts/${otherAccount}/Messages.json`]);
  expect(calls()[0].headers.get('Authorization')).toBe(`Basic ${Buffer.from(`${otherAccount}:${otherToken}`).toString('base64')}`);
});
it('Zavu inactive sender is provably unavailable; ambiguous inventory and sender swap fail closed', async () => {
  const c = channels.connections[1]; c._license = { manually_disabled: true };
  expectSafe(await attemptRoutedText(input()), 'unavailable');
  delete c._license; c.zavu_sender_id = 'replacement'; expectSafe(await attemptRoutedText(input()), 'failed');
  channels.connections.push({ ...c }); expectSafe(await attemptRoutedText(input()), 'failed');
  expect(net).not.toHaveBeenCalled();
});
it.each([zRoute, tRoute])('$provider: final license recheck stops dispatch after a valid approval GET', async route => {
  const ref = await submitted(route); net.mockClear(); zTemplate.status = approval = 'approved';
  net.mockImplementation(async (url, init) => {
    const response = await remote(url, init);
    if (String(url) === `${zApi}/templates/tpl_z` || String(url).endsWith('/ApprovalRequests')) {
      channels.connections[1].license_suspended = true; channels.whatsapp.enabled = false;
    }
    return response;
  });
  expectSafe(await attemptRoutedText(input(route, { template: ref })), 'unavailable');
  expect(calls().every(c => c.method === 'GET')).toBe(true);
});
it.each([zRoute, tRoute])('$provider rethrows the original suppression/conflict, including at the final dispatch guard', async route => {
  const ref = await submitted(route); net.mockClear(); zTemplate.status = approval = 'approved';
  const conflict = Object.assign(new Error('saved message ownership changed'), { status: 409 });
  const suppressed = new AutomationSendSuppressed('agent_snoozed');
  verify.mockRejectedValueOnce(suppressed);
  await expect(attemptRoutedText(input(route))).rejects.toBe(suppressed);
  expect(net).not.toHaveBeenCalled();
  verify.mockResolvedValueOnce(undefined).mockRejectedValueOnce(conflict);
  await expect(attemptRoutedText(input(route, { template: ref }))).rejects.toBe(conflict);
  expect(calls().every(c => c.method === 'GET')).toBe(true);
});
it.each([zRoute, tRoute])('$provider: a stalled message POST times out as unknown and never gets retried', async route => {
  jest.useFakeTimers(); let resolve!: (r: Response) => void;
  net.mockImplementationOnce(() => new Promise<Response>(r => { resolve = r; }));
  const attempt = attemptRoutedText(input(route));
  await jest.advanceTimersByTimeAsync(60_000);
  expectSafe(await attempt, 'unknown');
  resolve(accepted(route.provider === 'zavu' ? zSend : tSend)); await jest.advanceTimersByTimeAsync(1);
  expect(net).toHaveBeenCalledTimes(1); expect(verify).toHaveBeenCalledTimes(1);
});
it('a guard that finishes after its deadline cannot dispatch in the background', async () => {
  jest.useFakeTimers(); let release!: () => void;
  verify.mockImplementationOnce(() => new Promise<void>(r => { release = r; }));
  const attempt = expect(attemptRoutedText(input())).rejects.toThrow('timed out');
  await jest.advanceTimersByTimeAsync(60_000); await attempt;
  release(); await jest.advanceTimersByTimeAsync(1); expect(net).not.toHaveBeenCalled();
});
it.each([input(zRoute, { text: 'Hi {{lead.name}}' }), input(zRoute, { text: '', forceTemplate: true }),
  input(zRoute, { text: 'a'.repeat(1025), forceTemplate: true }), input(tRoute, { text: 'a'.repeat(1501) }),
  input(tRoute, { recipient: '555-no-normalization' }), input(tRoute, { template: { id: '' } })])(
  'does not change invalid content, chunk or degrade templates to plain text (%#)', async invalid => {
    expectSafe(await attemptRoutedText(invalid), 'failed'); expect(net).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
  });

it.each([zRoute, tRoute])('$provider: a guard that loses ownership after creation is rethrown without submitting', async route => {
  const conflict = Object.assign(new Error('claim was replaced'), { status: 409 });
  verify.mockImplementation(async () => { if (calls().some(c => c.method === 'POST')) throw conflict; });
  await expect(attemptRoutedText(input(route, { forceTemplate: true }))).rejects.toBe(conflict);
  expect(urls()).toEqual([`POST ${route.provider === 'zavu' ? `${zApi}/templates` : contentUrl}`]);
});
it('Zavu validates the create and submit response bodies rather than accepting a substituted resource', async () => {
  net.mockImplementationOnce(async (url, init) => {
    await remote(url, init); return json({ ...zTemplate, body: body.trim() });
  });
  expectSafe(await attemptRoutedText(input(zRoute, { forceTemplate: true })), 'failed');
  expect(urls()).toEqual([`POST ${zApi}/templates`]); net.mockClear();
  net.mockImplementationOnce(remote).mockImplementationOnce(async (url, init) => {
    await remote(url, init); return json({ ...zTemplate, id: 'another-template' });
  });
  expectSafe(await attemptRoutedText(input(zRoute, { forceTemplate: true })), 'failed');
  expect(urls()).toEqual([`POST ${zApi}/templates`, `POST ${zApi}/templates/tpl_z/submit`]);
});
it('Twilio refuses to submit modified create content or to adopt a different submitted approval', async () => {
  net.mockImplementationOnce(async (url, init) => {
    await remote(url, init); return json({ ...tTemplate, types: { 'twilio/text': { body: 'Truncated' } } });
  });
  expectSafe(await attemptRoutedText(input(tRoute, { forceTemplate: true })), 'failed');
  expect(urls()).toEqual([`POST ${contentUrl}`]); net.mockClear();
  net.mockImplementationOnce(remote).mockResolvedValueOnce(json({ status: 'received', content_sid: `HX${hex()}` }));
  expectSafe(await attemptRoutedText(input(tRoute, { forceTemplate: true })), 'failed');
  expect(tables.whatsapp_templates).toHaveLength(0);
  expect(urls()).toEqual([`POST ${contentUrl}`, `POST ${contentUrl}/${hSid}/ApprovalRequests/whatsapp`]);
});
it('Twilio: a lost optional catalog write still returns the submitted SID for polling', async () => {
  net.mockImplementationOnce(remote).mockImplementationOnce(async (url, init) => {
    errors.add('whatsapp_templates'); return remote(url, init);
  });
  const ref = await submitted(tRoute); approval = 'approved';
  expect(tables.whatsapp_templates).toHaveLength(0);
  expect(await attemptRoutedText(input(tRoute, { template: ref }))).toEqual({ kind: 'accepted', providerMessageId: smSid });
  expect(urls()).toEqual([`POST ${contentUrl}`, `POST ${contentUrl}/${hSid}/ApprovalRequests/whatsapp`,
    `GET ${contentUrl}/${hSid}`, `GET ${contentUrl}/${hSid}/ApprovalRequests`, `POST ${tSend}`]);
});
it.each([zRoute, tRoute])('$provider: unknown template language or settings outage cannot turn forceTemplate into a plain send', async route => {
  tables.settings[0].default_locale = 'xx-invalid';
  expectSafe(await attemptRoutedText(input(route, { forceTemplate: true })), 'failed');
  errors.add('settings'); expectSafe(await attemptRoutedText(input(route, { forceTemplate: true })), 'failed');
  expect(net).not.toHaveBeenCalled();
});
