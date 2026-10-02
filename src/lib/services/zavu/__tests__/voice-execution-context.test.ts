import { randomBytes } from 'node:crypto';

const mockFrom = jest.fn();
const mockFollowUp = jest.fn();
jest.mock('@/lib/database/supabase-server', () => ({ supabaseAdmin: { schema: () => ({ from: mockFrom }) } }));
jest.mock('../voice-follow-up-context', () => ({ buildVoiceFollowUpContext: mockFollowUp }));
import { loadVoiceExecutionContext } from '../voice-execution-context';

const SITE = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const MESSAGE = '33333333-3333-4333-8333-333333333333';

describe('private voice execution context', () => {
  const input = { siteId: SITE, conversationId: CONVERSATION, messageId: MESSAGE, direction: 'outbound' as const };
  let query: any;
  beforeEach(() => {
    jest.clearAllMocks();
    query = { select: jest.fn(), eq: jest.fn(), maybeSingle: jest.fn() };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    mockFrom.mockReturnValue(query);
    mockFollowUp.mockResolvedValue({ context: 'Prior customer request for Monday at five.' });
  });

  it('returns call-specific purpose and history without dumping arbitrary metadata', async () => {
    const secret = randomBytes(24).toString('hex');
    query.maybeSingle.mockResolvedValue({ data: { custom_data: {
      tool_execution_context: { version: 1, site_id: SITE, intent: 'Confirm Monday at five', source: { tool: 'publish', conversation_id: CONVERSATION } },
      voice_additional_context: `Verify availability first. password=${secret}`,
      voice_follow_up_context: 'Customer requested Monday; booking failed.',
      private_key: secret,
    } }, error: null });
    const result = await loadVoiceExecutionContext(input);
    expect(result).toMatchObject({ direction: 'outbound', objective: 'Confirm Monday at five', source: { tool: 'publish' } });
    expect(result.follow_up_context).toContain('booking failed');
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result).not.toHaveProperty('private_key');
    expect(query.eq).toHaveBeenCalledWith('id', MESSAGE);
    expect(query.eq).toHaveBeenCalledWith('conversation_id', CONVERSATION);
    expect(query.eq).toHaveBeenCalledWith('conversations.site_id', SITE);
    expect(mockFollowUp).not.toHaveBeenCalled();
  });

  it('ignores foreign-site envelopes and rebuilds missing inbound history from the bound conversation', async () => {
    query.maybeSingle.mockResolvedValue({ data: { lead_id: MESSAGE, custom_data: {
      tool_execution_context: { version: 1, site_id: CONVERSATION, intent: 'Wrong tenant intent', source: {} },
    } }, error: null });
    const result = await loadVoiceExecutionContext({ ...input, direction: 'inbound' });
    expect(result.objective).toBeUndefined();
    expect(result.follow_up_context).toContain('Monday');
    expect(mockFollowUp).toHaveBeenCalledWith({ siteId: SITE, leadId: MESSAGE, conversationId: CONVERSATION, excludeMessageId: MESSAGE });
  });

  it.each([{ data: null, error: null }, { data: null, error: { message: 'Unavailable' } }])('fails closed when the bound message is unavailable', async response => {
    query.maybeSingle.mockResolvedValue(response);
    await expect(loadVoiceExecutionContext(input)).rejects.toThrow('not ready');
    expect(mockFollowUp).not.toHaveBeenCalled();
  });
});