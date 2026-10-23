import { randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
const from = jest.fn<any>();
const rpc = jest.fn<(name: string, args: { p_site_id: string }) => {
  abortSignal: (signal: AbortSignal) => Promise<{ data: unknown; error: unknown }>;
}>();
type GetAudience = typeof import('@/lib/database/audience-db').getAudienceById;
type AudienceSnapshot = Pick<NonNullable<Awaited<ReturnType<GetAudience>>>, 'id' | 'site_id' | 'status' | 'total_count' | 'page_size'>;
const audience = jest.fn<(...args: Parameters<GetAudience>) => Promise<AudienceSnapshot | null>>();
const page = jest.fn<typeof import('@/lib/database/audience-db').getAudiencePageForSending>();
const status = jest.fn<typeof import('@/lib/database/audience-db').updateAudienceLeadStatus>();
const send = jest.fn<typeof import('@/lib/messaging/exact-delivery').sendExactDelivery>();
type GetWhatsAppConfig = typeof import('@/lib/messaging/exact-delivery').getExactWhatsAppConfig;
type WhatsAppConfigSnapshot = Pick<NonNullable<Awaited<ReturnType<GetWhatsAppConfig>>>, 'phoneNumberId' | 'accessToken' | 'fromNumber'>;
const config = jest.fn<(...args: Parameters<GetWhatsAppConfig>) => Promise<WhatsAppConfigSnapshot | null>>();
type TemplateService = typeof import('@/lib/services/whatsapp/WhatsAppTemplateService').WhatsAppTemplateService;
const findTemplate = jest.fn<TemplateService['findExistingTemplate']>();
const createTemplate = jest.fn<TemplateService['createTemplate']>();
jest.unstable_mockModule('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from, rpc } }));
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
    { id: 'wa-1', type: 'whatsapp', status: 'connected', license_suspended: false, zavu_sender_id: 'wa-sender-1' },
    { id: 'wa-2', type: 'whatsapp', status: 'connected', license_suspended: false, zavu_sender_id: 'wa-sender-2' },
    { id: 'email-1', type: 'email', status: 'connected', license_suspended: false, zavu_sender_id: 'mail-1' },
    { id: 'email-2', type: 'email', status: 'connected', license_suspended: false, zavu_sender_id: 'mail-2' },
  ] };
  rpc.mockImplementation((name, args) => {
    expect(name).toBe('get_site_licensed_resources');
    expect(args).toEqual({ p_site_id: siteId });
    return { abortSignal: async (signal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      return { data: { channels, social_media: [], effective_plan: 'engine' }, error: null };
    } };
  });
  audience.mockResolvedValue({ id: audienceId, site_id: siteId, status: 'ready', total_count: 1, page_size: 100 });
  page.mockResolvedValue({ leads: [{ id: leadId, site_id: siteId, name: 'Ada Lovelace', phone: '+14155550101', email: 'ada@example.invalid' }], total_in_page: 1 });
  status.mockResolvedValue(undefined); send.mockResolvedValue({ success: true, status: 'sent' });
  config.mockResolvedValue({ phoneNumberId: 'account-2', accessToken: randomBytes(24).toString('hex'), fromNumber: '+14155550102' });
  findTemplate.mockResolvedValue({ templateSid: 'template-2', templatedBody: 'Hello audience', placeholderMap: [] });
  from.mockImplementation((table: string) => {
    if (table === 'settings') throw new Error('Raw settings must not authorize delivery.');
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
    status.mockImplementation(async () => { page.mockResolvedValue({ leads: [], total_in_page: 0 }); });
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
    channels.agent_whatsapp = { status: 'active', account_sid: 'account-2', access_token: randomBytes(24).toString('hex'), existingNumber: '+14155550102' };
    const result = await tool(siteId).execute({ audience_id: audienceId, message: 'Hello audience', channel: 'whatsapp', connection_id: 'legacy:agent_whatsapp' });
    expect(result.success).toBe(true);
    expect(config).toHaveBeenCalledWith(siteId, 'legacy:agent_whatsapp');
    expect(findTemplate).toHaveBeenCalledWith('Hello audience', siteId, 'account-2', { trackUsage: false });
    expect(messages[0].custom_data).toMatchObject({ connection_id: 'legacy:agent_whatsapp', template_sid: 'template-2' });
  });
  it.each(['suspended', 'unavailable'])('denies %s licensed projection before recipient reads or writes', async condition => {
    if (condition === 'suspended') channels.connections[0].license_suspended = true;
    else rpc.mockReturnValue({ abortSignal: async () => ({ data: null, error: { code: 'PGRST202' } }) });
    const result = await tool(siteId).execute({ audience_id: audienceId, message: 'Hello', channel: 'whatsapp', connection_id: 'wa-1' });
    expect(result.success).toBe(false);
    expect(rpc).toHaveBeenCalledWith('get_site_licensed_resources', { p_site_id: siteId });
    expect(from).not.toHaveBeenCalled();
    expect(page).not.toHaveBeenCalled();
    expect(messages).toHaveLength(0); expect(conversations).toHaveLength(0);
    expect(send).not.toHaveBeenCalled(); expect(findTemplate).not.toHaveBeenCalled(); expect(status).not.toHaveBeenCalled();
  });
});