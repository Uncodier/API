import { randomBytes } from 'node:crypto';

// Only DB and HTTP boundaries are replaced: finder, creator, approval, dispatcher
// and lower Twilio transport are all real modules, including request serialization.
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));

import { supabaseAdmin } from '@/lib/database/supabase-client';
import { WhatsAppTemplateService } from '@/lib/services/whatsapp/WhatsAppTemplateService';
import { sendTwilioWhatsAppMessage } from '@/lib/services/whatsapp/twilio-whatsapp-transport';
import { prepareExactWhatsAppTemplate } from '@/app/api/agents/tools/sendBulkMessages/exact-whatsapp-template';
import { buildContentVariablesForLead, extractMergeTokens } from '../lead-merge-fields';
import { canonicalExactTemplateBody } from '../exact-template-body';
import { exactWhatsAppConfig, sendExactTwilio } from '../exact-whatsapp';
import type { OutreachAccount } from '@/lib/services/outreach/policy';
import { whatsappTestDb } from './exact-whatsapp-test-db';

const siteId = 'test-site';
const accountSid = `AC${randomBytes(16).toString('hex')}`;
const messagingServiceSid = `MG${randomBytes(16).toString('hex')}`;
const authToken = randomBytes(24).toString('hex');
const newTemplateSid = `HX${randomBytes(16).toString('hex')}`;
const selectedFrom = '+15555550101';
const lead = { name: 'Ada', email: 'ada@example.invalid' };
const oldCampaign = 'Hello {{lead.name}}, our autumn campaign offers a 10% discount on your next order. Visit https://example.invalid/autumn to learn more and reserve your place today.';
const newCampaign = 'Hello {{lead.name}}, our autumn campaign offers a 20% discount on your next order. Visit https://example.invalid/autumn to learn more and reserve your place today.';
type Row = Record<string, any>;
let tables: Record<string, Row[]>;
let requests: Array<{ url: string; init: RequestInit }>;
let approvalStatus: string;
let sendError: number | undefined;
const originalFetch = global.fetch;

function account(overrides: Row = {}): OutreachAccount {
  return { id: 'legacy:whatsapp', channel: 'whatsapp', provider: 'whatsapp',
    config: { account_sid: accountSid, access_token: authToken, existingNumber: selectedFrom,
      messaging_service_sid: messagingServiceSid, ...overrides } };
}

function template(message: string, overrides: Row = {}): Row {
  const { templated, tokens } = extractMergeTokens(message);
  return { template_sid: `HX${randomBytes(16).toString('hex')}`, site_id: siteId, account_sid: accountSid,
    templated_body: canonicalExactTemplateBody(templated), placeholder_map: tokens,
    status: 'approved', created_at: new Date().toISOString(), ...overrides };
}

function exactInput(overrides: Row = {}): Parameters<typeof sendExactTwilio>[0] {
  return { siteId, account: account(), to: '+15555550102', message: 'Hello Ada, this is an exact message.',
    rawMessage: 'Hello Ada, this is an exact message.', conversationId: 'conversation',
    lead, siteName: 'Example', beforeDispatch: jest.fn(async () => {}), ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  tables = { whatsapp_templates: [], messages: [
    { conversation_id: 'conversation', role: 'user', created_at: new Date().toISOString() },
  ] };
  requests = []; approvalStatus = 'pending'; sendError = undefined;
  (supabaseAdmin.from as jest.Mock).mockImplementation(whatsappTestDb(tables));
  global.fetch = jest.fn(async (url, init) => {
    const address = String(url);
    requests.push({ url: address, init: init! });
    if (address === 'https://content.twilio.com/v1/Content') {
      return Response.json({ sid: newTemplateSid });
    }
    if (address.endsWith('/ApprovalRequests/whatsapp')) return Response.json({ status: 'received' });
    if (address.endsWith('/ApprovalRequests')) return Response.json({ whatsapp: { status: approvalStatus } });
    if (address === `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`) {
      return sendError ? Response.json({ code: sendError, message: 'Selected sender unavailable' }, { status: 400 })
        : Response.json({ sid: 'test-message', status: 'queued', from: `whatsapp:${selectedFrom}` });
    }
    throw new Error(`Unexpected HTTP target: ${address}`);
  }) as typeof fetch;
});

afterEach(() => { global.fetch = originalFetch; });

it('pins the selected From through real sendExactTwilio -> real transport with a service present', async () => {
  const input = exactInput();
  expect(await sendExactTwilio(input)).toMatchObject({ success: true, messageId: 'test-message' });
  expect(input.beforeDispatch).toHaveBeenCalledTimes(1);
  expect(requests).toHaveLength(1);
  const body = new URLSearchParams(requests[0].init.body as string);
  expect(body.get('From')).toBe(`whatsapp:${selectedFrom}`);
  expect(body.get('MessagingServiceSid')).toBe(messagingServiceSid);
  expect(body.get('To')).toBe('whatsapp:+15555550102');
  expect(body.get('Body')).toBe(input.message);
});

it('preserves non-exact service pool selection (no From)', async () => {
  expect((await sendTwilioWhatsAppMessage({ phoneNumber: '+15555550102', message: 'Legacy message',
    accountSid, authToken, fromNumber: selectedFrom, messagingServiceSid })).success).toBe(true);
  const body = new URLSearchParams(requests[0].init.body as string);
  expect(body.get('MessagingServiceSid')).toBe(messagingServiceSid);
  expect(body.has('From')).toBe(false);
});

it('fails service-only exact config before DB, HTTP or dispatch admission', async () => {
  const selected = account({ existingNumber: undefined });
  await expect(exactWhatsAppConfig(siteId, selected)).rejects.toMatchObject({ code: 'EXACT_SENDER_UNAVAILABLE' });
  const input = exactInput({ account: selected });
  await expect(sendExactTwilio(input)).rejects.toThrow('no exact From number');
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
  expect(requests).toHaveLength(0);
  expect(input.beforeDispatch).not.toHaveBeenCalled();
});

it.each([messagingServiceSid, undefined])('never retries a different selected sender after 63007 with service %s', async service => {
  sendError = 63007;
  const result = await sendExactTwilio(exactInput({ account: account({ messaging_service_sid: service }) }));
  expect(result).toMatchObject({ success: false, errorCode: 63007 });
  expect(requests).toHaveLength(1);
  expect(new URLSearchParams(requests[0].init.body as string).get('From')).toBe(`whatsapp:${selectedFrom}`);
});

it('rejects the real fuzzy finder result, creates exact campaign content, then sends only after approval', async () => {
  const old = template(oldCampaign);
  tables.whatsapp_templates.push(old, template(newCampaign, { account_sid: 'another-account' }),
    template(newCampaign, { site_id: 'another-site' }));
  // Prove this fixture hits the actual >0.8 fuzzy branch, not a mocked result.
  const fuzzy = await WhatsAppTemplateService.findExistingTemplate(newCampaign, siteId, accountSid, { trackUsage: false });
  expect(fuzzy.templateSid).toBe(old.template_sid);
  expect(fuzzy.templatedBody).not.toBe(canonicalExactTemplateBody(extractMergeTokens(newCampaign).templated));
  const prepared = await prepareExactWhatsAppTemplate({ message: newCampaign, siteId, accountSid, accessToken: authToken });
  expect(prepared).toEqual({ templateSid: newTemplateSid, templateStatus: 'pending',
    templatedBody: canonicalExactTemplateBody(extractMergeTokens(newCampaign).templated), placeholderMap: ['lead.name'] });
  const created = tables.whatsapp_templates.find(row => row.template_sid === newTemplateSid)!;
  expect(created.status).toBe('pending');
  expect(created.templated_body).toBe(prepared.templatedBody);
  const contentRequest = requests.find(request => request.url.endsWith('/Content'))!;
  expect(JSON.parse(contentRequest.init.body as string).types['twilio/text'].body).toBe(prepared.templatedBody);
  const built = buildContentVariablesForLead(prepared.placeholderMap, lead as any, 'Example', 'strip_unresolved');
  const input = exactInput({ conversationId: undefined, rawMessage: prepared.templatedBody,
    templateSid: prepared.templateSid, message: prepared.templatedBody.replace('{{1}}', 'Ada') });
  await expect(sendExactTwilio(input)).rejects.toMatchObject({ code: 'APPROVED_TEMPLATE_REQUIRED' });
  expect(input.beforeDispatch).not.toHaveBeenCalled();
  expect(requests.filter(request => request.url.endsWith('/Messages.json'))).toHaveLength(0);
  // Explicit subsequent attempt after approval; no automatic pending-template retry.
  approvalStatus = 'approved';
  expect((await sendExactTwilio(input)).success).toBe(true);
  const sent = requests.filter(request => request.url.endsWith('/Messages.json'));
  expect(sent).toHaveLength(1);
  const body = new URLSearchParams(sent[0].init.body as string);
  expect(body.get('ContentSid')).toBe(newTemplateSid);
  expect(JSON.parse(body.get('ContentVariables')!)).toEqual(built.variables);
  expect(body.get('From')).toBe(`whatsapp:${selectedFrom}`);
  expect(body.get('MessagingServiceSid')).toBe(messagingServiceSid);
  expect(body.has('Body')).toBe(false);
});

it('reuses pending exact body/maps without creating duplicate templates, canonically normalizing aliases and whitespace', async () => {
  const pending = template(newCampaign, { status: 'pending' });
  tables.whatsapp_templates.push(template(oldCampaign), pending);
  const prepared = await prepareExactWhatsAppTemplate({ message: newCampaign.replace('{{lead.name}}', '{{lead.full_name}}').replace('our autumn', 'our\n\n autumn'),
    siteId, accountSid, accessToken: authToken });
  expect(prepared).toEqual({ templateSid: pending.template_sid, templatedBody: pending.templated_body,
    placeholderMap: ['lead.name'], templateStatus: 'pending' });
  expect(requests).toHaveLength(0);
});

it('creates a new exact template rather than reusing the same numbered body with a different merge map', async () => {
  tables.whatsapp_templates.push(template(newCampaign, { placeholder_map: ['lead.email'] }));
  const prepared = await prepareExactWhatsAppTemplate({ message: newCampaign, siteId, accountSid, accessToken: authToken });
  expect(prepared.templateSid).toBe(newTemplateSid);
  expect(prepared.placeholderMap).toEqual(['lead.name']);
  expect(prepared.templateStatus).toBe('pending');
});

it('reuses an approved exact campaign and sends its canonical body/map through the real transport', async () => {
  const approved = template(newCampaign);
  tables.whatsapp_templates.push(template(oldCampaign), approved);
  const prepared = await prepareExactWhatsAppTemplate({ message: newCampaign.replace('our autumn', 'our\n autumn'),
    siteId, accountSid, accessToken: authToken });
  expect(prepared).toEqual({ templateSid: approved.template_sid, templateStatus: 'approved',
    templatedBody: approved.templated_body, placeholderMap: ['lead.name'] });
  expect(requests).toHaveLength(0);
  approvalStatus = 'approved';
  expect((await sendExactTwilio(exactInput({ conversationId: undefined, templateSid: prepared.templateSid,
    rawMessage: prepared.templatedBody, message: prepared.templatedBody.replace('{{1}}', 'Ada') }))).success).toBe(true);
  expect(requests.map(request => request.init.method)).toEqual(['GET', 'POST']);
  const body = new URLSearchParams(requests[1].init.body as string);
  expect(body.get('ContentSid')).toBe(approved.template_sid);
  expect(body.get('ContentVariables')).toBe(JSON.stringify({ '1': 'Ada' }));
  expect(body.get('From')).toBe(`whatsapp:${selectedFrom}`);
  expect(body.get('MessagingServiceSid')).toBe(messagingServiceSid);
});