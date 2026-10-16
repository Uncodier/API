import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
const from = jest.fn<any>();
const audience = jest.fn<any>();
const page = jest.fn<any>();
const status = jest.fn<any>();
const send = jest.fn<any>();
const config = jest.fn<any>();
const findTemplate = jest.fn<any>();
const createTemplate = jest.fn<any>();
jest.unstable_mockModule('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from } }));
jest.unstable_mockModule('@/lib/database/audience-db', () => ({ getAudienceById: audience, getAudiencePageForSending: page, updateAudienceLeadStatus: status }));
jest.unstable_mockModule('@/lib/messaging/exact-delivery', () => ({ sendExactDelivery: send, getExactWhatsAppConfig: config }));
jest.unstable_mockModule('@/lib/services/whatsapp/WhatsAppTemplateService', () => ({ WhatsAppTemplateService: { findExistingTemplate: findTemplate, createTemplate } }));
jest.unstable_mockModule('../support', () => ({
  findActiveSalesAgent: async () => null, resolvePlaceholderPolicy: async () => 'strip_tokens',
  resolveNumberedTemplate: (body: string, variables: Record<string, string>) => body.replace(/\{\{(\d+)\}\}/g, (_match, id) => variables[id] ?? ''),
}));
let tool: typeof import('../assistantProtocol').sendBulkMessagesTool;
beforeAll(async () => { ({ sendBulkMessagesTool: tool } = await import('../assistantProtocol')); });
const siteId = randomUUID();
const audienceId = randomUUID();
const leadId = randomUUID();
let messages: any[];
let conversations: any[];
let channels: any;
beforeEach(() => {
  jest.clearAllMocks(); messages = []; conversations = [];
  channels = { connections: [
    { id: 'wa-1', type: 'whatsapp', status: 'connected', zavu_sender_id: 'wa-sender-1' },
    { id: 'wa-2', type: 'whatsapp', status: 'connected', zavu_sender_id: 'wa-sender-2' },
    { id: 'email-1', type: 'email', status: 'connected', zavu_sender_id: 'mail-1' },
    { id: 'email-2', type: 'email', status: 'connected', zavu_sender_id: 'mail-2' },
  ] };
  audience.mockResolvedValue({ id: audienceId, site_id: siteId, status: 'ready', total_count: 1, page_size: 100 });
  page.mockResolvedValue({ leads: [{ id: leadId, site_id: siteId, name: 'Ada Lovelace', phone: '+14155550101', email: 'ada@example.invalid' }], total_in_page: 1 });
  status.mockResolvedValue(undefined); send.mockResolvedValue({ success: true, status: 'sent' });
  config.mockResolvedValue({ phoneNumberId: 'account-2', accessToken: 'synthetic', fromNumber: '+14155550102' });
  findTemplate.mockResolvedValue({ templateSid: 'template-2', templatedBody: 'Hello audience', placeholderMap: [] });
  from.mockImplementation((table: string) => {
    if (table === 'settings') return { select: () => ({ eq: (_key: string, id: string) => {
      expect(id).toBe(siteId); return { single: async () => ({ data: { channels }, error: null }) };
    } }) };
    if (table === 'sites') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { name: 'Acme' } }) }) }) };
    if (table === 'conversations') return { insert: (rows: any[]) => {
      conversations.push(...rows); return { select: () => ({ single: async () => ({ data: { id: randomUUID() } }) }) };
    } };
    if (table === 'messages') return { insert: async (rows: any[]) => { messages.push(...rows); return { error: null }; } };
    if (table === 'whatsapp_templates') {
      const query: any = { select: () => query, eq: () => query,
        maybeSingle: async () => ({ data: { template_sid: 'template-2', templated_body: 'Hello audience', placeholder_map: [], status: 'approved' }, error: null }) };
      return query;
    }
    throw new Error(`Unexpected table ${table}`);
  });
});
describe('exact bulk tool orchestration', () => {
  it('accepts connection_id and delivery_routes in tool definition without requiring top-level channel', () => {
    const definition = tool(siteId).parameters;
    expect(definition.properties).toHaveProperty('connection_id');
    expect(definition.properties).toHaveProperty('delivery_routes');
    expect(definition.required).not.toContain('channel');
  });
  it('queues both selected WhatsApps using the same pending lead snapshot, no Twilio templates for Zavu', async () => {
    // A real status update consumes pending leads; deferred status must not hide the second route.
    status.mockImplementation(async () => page.mockResolvedValue({ leads: [], total_in_page: 0 }));
    const routes = [{ channel: 'whatsapp' as const, connection_id: 'wa-2' }, { channel: 'whatsapp' as const, connection_id: 'wa-1' }];
    const result = await tool(siteId).execute({ audience_id: audienceId, message: 'Hello {{lead.first_name}}', delivery_routes: routes });
    expect(result.success).toBe(true);
    expect(page).toHaveBeenCalledTimes(1);
    expect(messages.map(row => [row.lead_id, row.content, row.custom_data.connection_id])).toEqual([
      [leadId, 'Hello Ada', 'wa-2'], [leadId, 'Hello Ada', 'wa-1'],
    ]);
    expect(conversations.map(row => row.custom_data.connection_id)).toEqual(['wa-2', 'wa-1']);
    expect(findTemplate).not.toHaveBeenCalled(); expect(config).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledTimes(1);
  });
  it('uses independent mail/newsletter connections and preserves the newsletter exact provider handoff', async () => {
    const result = await tool(siteId).execute({ audience_id: audienceId, subject: 'News', message: 'Hello Ada', delivery_routes: [
      { channel: 'email', connection_id: 'email-2', audience_email_mode: 'mail' },
      { channel: 'email', connection_id: 'email-1', audience_email_mode: 'newsletter' },
    ] });
    expect(result.success).toBe(true);
    expect(messages).toHaveLength(1);
    expect(messages[0].custom_data.connection_id).toBe('email-2');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ site_id: siteId, connection_id: 'email-1', channel: 'email', to: 'ada@example.invalid', omit_signature: true }));
    expect(status).toHaveBeenCalledTimes(1);
  });
  it.each(['foreign', 'email-1'])('invalid second route %s rejects all routes before writes, templates or sends', async connection_id => {
    const result = await tool(siteId).execute({ audience_id: audienceId, message: 'Hello', delivery_routes: [
      { channel: 'whatsapp', connection_id: 'wa-2' }, { channel: 'whatsapp', connection_id },
    ] });
    expect(result.success).toBe(false);
    expect(messages).toHaveLength(0); expect(conversations).toHaveLength(0);
    expect(send).not.toHaveBeenCalled(); expect(findTemplate).not.toHaveBeenCalled(); expect(status).not.toHaveBeenCalled();
  });
  it('selects the exact legacy WhatsApp account for campaign template creation and queue delivery', async () => {
    channels.agent_whatsapp = { status: 'active', account_sid: 'account-2', access_token: 'synthetic', existingNumber: '+14155550102' };
    const result = await tool(siteId).execute({ audience_id: audienceId, message: 'Hello audience', channel: 'whatsapp', connection_id: 'legacy:agent_whatsapp' });
    expect(result.success).toBe(true);
    expect(config).toHaveBeenCalledWith(siteId, 'legacy:agent_whatsapp');
    expect(findTemplate).toHaveBeenCalledWith('Hello audience', siteId, 'account-2', { trackUsage: false });
    expect(messages[0].custom_data).toMatchObject({ connection_id: 'legacy:agent_whatsapp', template_sid: 'template-2' });
  });
});