import { randomBytes, randomUUID } from 'node:crypto';

const mockFrom = jest.fn();
const mockAudience = jest.fn();
const mockPage = jest.fn();
const mockStatus = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: mockFrom } }));
jest.mock('@/lib/database/audience-db', () => ({
  getAudienceById: mockAudience, getAudiencePageForSending: mockPage, updateAudienceLeadStatus: mockStatus,
}));
jest.mock('../../sendEmail/core', () => ({ sendEmailCore: jest.fn() }));
jest.mock('@/lib/services/whatsapp/WhatsAppSendService', () => ({ WhatsAppSendService: {} }));
jest.mock('@/lib/services/whatsapp/WhatsAppTemplateService', () => ({ WhatsAppTemplateService: {} }));
jest.mock('../support', () => ({
  ...jest.requireActual('../support'),
  resolvePlaceholderPolicy: async () => 'strip_tokens', findActiveSalesAgent: async () => null,
}));
import { sendBulkMessagesTool } from '../assistantProtocol';
import { buildToolExecutionContext, type ToolExecutionContext } from '@/lib/services/tool-execution-context';

const siteId = randomUUID();
const audienceId = randomUUID();
const contentId = randomUUID();
const leadIds = [randomUUID(), randomUUID()];

describe('recipient-private execution context', () => {
  let messages: any[];
  let conversations: any[];
  beforeEach(() => {
    jest.clearAllMocks(); messages = []; conversations = [];
    mockAudience.mockResolvedValue({ id: audienceId, site_id: siteId, status: 'ready', total_count: 2, page_size: 100 });
    mockPage.mockResolvedValue({ leads: leadIds.map((id, index) => ({ id,
      name: index ? 'Grace Hopper' : 'Ada Lovelace', email: `recipient${index}@example.invalid`,
      phone: index ? '+14155550102' : '+14155550101', metadata: { preferred_slot: index ? 'Tuesday' : 'Monday' },
    })) });
    mockStatus.mockResolvedValue(undefined);
    mockFrom.mockImplementation((table: string) => {
      if (table === 'sites') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { name: 'Acme' } }) }) }) };
      if (table === 'conversations') return { insert: (rows: any[]) => {
        conversations.push(...rows);
        return { select: () => ({ single: async () => ({ data: { id: randomUUID() }, error: null }) }) };
      } };
      if (table === 'messages') return { insert: async (rows: any[]) => { messages.push(...rows); return { error: null }; } };
      throw new Error(`Unexpected table ${table}`);
    });
  });

  it.each(['voice', 'sms', 'telegram', 'email'] as const)('queues %s with a private envelope, never appending it to recipient text', async channel => {
    const password = randomBytes(24).toString('hex');
    const intent = 'Ask for availability. '.repeat(90);
    const context = { version: 1 as const, site_id: siteId, intent: `${intent}password=${password}`,
      background: 'Unrelated lead private conversation transcript',
      history: 'Forbidden history', source: { tool: 'publish', content_id: contentId, conversation_id: randomUUID() } };
    const args = { audience_id: audienceId, content_id: contentId, channel,
      ...(channel === 'voice' ? { voice_mode: 'agent_call' as const } : {}),
      ...(channel === 'email' ? { subject: 'Hello {{lead.first_name}}' } : {}), message: 'Hello {{lead.first_name}}.' };
    const result = await sendBulkMessagesTool(siteId).execute(args, context);
    expect(result).toMatchObject({ success: true, total_sent: 2 });
    expect(messages).toHaveLength(2);
    expect(messages.map(message => message.content)).toEqual(['Hello Ada.', 'Hello Grace.']);
    messages.forEach((message, index) => {
      const stored = message.custom_data.tool_execution_context;
      expect(stored).toMatchObject({ version: 1, site_id: siteId,
        source: { tool: 'publish', content_id: contentId, audience_id: audienceId } });
      expect(stored.intent.length).toBeGreaterThan(500);
      expect(stored).not.toHaveProperty('background');
      expect(stored).not.toHaveProperty('history');
      expect(stored.source).not.toHaveProperty('conversation_id');
      expect(stored.source).not.toHaveProperty('message_id');
      expect(message.lead_id).toBe(leadIds[index]);
      expect(message.custom_data).not.toHaveProperty('voice_objective');
      expect(JSON.stringify(message)).not.toContain(password);
      expect(message.content).not.toContain(intent);
    });
    expect(messages[0].custom_data.tool_execution_context).not.toBe(messages[1].custom_data.tool_execution_context);
    expect(JSON.stringify(result)).not.toContain('tool_execution_context');
    expect(JSON.stringify(messages)).not.toContain(context.background);
    expect(mockFrom.mock.calls.map(([table]) => table).every(table => ['sites', 'conversations', 'messages'].includes(table))).toBe(true);
    expect(args).not.toHaveProperty('objective');
  });

  it('explicit objective wins and is personalized independently for each recipient', async () => {
    const context = buildToolExecutionContext({ site_id: siteId, intent: 'Inherited fallback', source: {} });
    await sendBulkMessagesTool(siteId).execute({ audience_id: audienceId, channel: 'voice', voice_mode: 'agent_call',
      message: 'Hello {{lead.first_name}}.', objective: 'Confirm {{lead.first_name}} availability',
      additional_context: 'Preferred day: {{lead.metadata.preferred_slot}}',
    }, context);
    expect(messages[0].custom_data.tool_execution_context).toMatchObject({
      intent: 'Confirm Ada availability', background: 'Preferred day: Monday',
    });
    expect(messages[1].custom_data.tool_execution_context).toMatchObject({
      intent: 'Confirm Grace availability', background: 'Preferred day: Tuesday',
    });
    expect(JSON.stringify(messages[1])).not.toContain('Monday');
    expect(JSON.stringify(messages[1])).not.toContain('Ada');
  });

  it('ignores foreign-site context and keeps legacy sends functional', async () => {
    const context: ToolExecutionContext = { version: 1, site_id: randomUUID(), intent: 'Foreign private purpose', source: {} };
    const args = { audience_id: audienceId, channel: 'sms' as const, message: 'Hello.' };
    await sendBulkMessagesTool(siteId).execute(args, context);
    await sendBulkMessagesTool(siteId).execute(args);
    expect(messages).toHaveLength(4);
    expect(JSON.stringify(messages)).not.toContain(context.intent);
    for (const message of messages) expect(message.content).toBe('Hello.');
  });

  it('redacts explicit private guidance in both the envelope and legacy voice fields', async () => {
    const password = randomBytes(24).toString('hex');
    const token = randomBytes(24).toString('hex');
    await sendBulkMessagesTool(siteId).execute({ audience_id: audienceId, channel: 'voice', voice_mode: 'agent_call',
      message: 'Hello.', objective: `Confirm availability. password=${password}`,
      additional_context: `Verify calendar. Bearer ${token}`,
    });
    expect(messages).toHaveLength(2);
    for (const secret of [password, token]) {
      expect(JSON.stringify(messages)).not.toContain(secret);
      expect(JSON.stringify(conversations)).not.toContain(secret);
    }
    expect(messages[0].custom_data.voice_objective).toContain('[REDACTED]');
    expect(messages[0].custom_data.voice_additional_context).toContain('[REDACTED]');
  });

  it('context source never authorizes a foreign audience or supplies missing tool arguments', async () => {
    const context = buildToolExecutionContext({ site_id: siteId, source: { audience_id: audienceId } });
    mockAudience.mockResolvedValueOnce({ site_id: randomUUID(), status: 'ready' });
    expect(await sendBulkMessagesTool(siteId).execute({ audience_id: audienceId, channel: 'sms', message: 'Hello.' }, context))
      .toMatchObject({ success: false, error: 'Audience does not belong to this site' });
    expect(await sendBulkMessagesTool(siteId).execute({ audience_id: '', channel: 'sms', message: 'Hello.' }, context))
      .toMatchObject({ success: false, error: 'Missing required field: audience_id' });
    expect(mockPage).not.toHaveBeenCalled();
    expect(messages).toHaveLength(0);
    expect(conversations).toHaveLength(0);
  });

  it('still validates the 500-character explicit objective, not the inherited envelope', async () => {
    const context = buildToolExecutionContext({ site_id: siteId, intent: 'i'.repeat(2_000) });
    expect(await sendBulkMessagesTool(siteId).execute({ audience_id: audienceId, channel: 'voice', voice_mode: 'agent_call',
      message: 'Hello.', objective: 'o'.repeat(501),
    }, context)).toMatchObject({ success: false, error: expect.stringContaining('500') });
    expect(mockAudience).not.toHaveBeenCalled();
  });
});