import { extractSupportResults } from '../results';
import { resolveSupportResults } from '../resolve-results';
import { saveMessages } from '../save-messages';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { saveCommentMessages } from '@/lib/services/social-comments/persistence';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn(), schema: jest.fn() } }));
jest.mock('@/lib/services/conversation-service', () => ({ ConversationService: {} }));
jest.mock('../agent-data', () => ({ isValidUUID: jest.fn(), validateLeadExists: jest.fn() }));
jest.mock('@/lib/services/social-comments/persistence', () => ({ saveCommentMessages: jest.fn() }));

describe('support response safety', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each([undefined, null, [], [null], [{ conversation: { title: 'Title' } }],
    [{ type: 'tool', content: 'Internal tool result' }], [{ unexpected: 'metadata' }],
    [{ message: { content: {} } }], [{ message: { content: '   ' } }],
    [{ message: { content: 'No response generated' } }],
    [{ type: 'text', content: ' NO RESPONSE GENERATED.! ' }],
  ])('does not invent a reply from invalid results %#', results => {
    expect(extractSupportResults({ results }).assistantMessage).toBeUndefined();
  });

  it.each([
    [{ message: { content: 'Hola' } }],
    [{ type: 'message', content: 'Hola' }],
    [{ type: 'text', content: { message: { content: 'Hola' } } }],
    [{ type: 'message', content: { content: 'Hola' } }],
    [{ content: { message: { content: 'Hola' } } }],
    [{ text: 'Hola' }], ['Hola'],
  ])('preserves supported text formats %#', (...results) => {
    expect(extractSupportResults({ results }).assistantMessage).toBe('Hola');
  });

  it('selects valid message content and preserves title and flags', () => {
    expect(extractSupportResults({ results: [
      { type: 'text', content: 'No response generated' },
      { message: { content: 'Hola', is_robot: false, is_erratic: false } },
      { conversation: { title: 'Greeting', is_transactional_message: false } },
    ] })).toEqual({ assistantMessage: 'Hola', conversationTitle: 'Greeting',
      isRobot: false, isErratic: false, isTransactionalMessage: false });
  });

  it('recovers persisted output when the completed snapshot has no results', async () => {
    const read = jest.fn().mockResolvedValue({ status: 'completed', results: [{ message: { content: 'Hola' } }] });
    expect(await resolveSupportResults({ status: 'completed', results: [] }, read))
      .toMatchObject({ assistantMessage: 'Hola' });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('does not read again when the response is usable', async () => {
    const read = jest.fn();
    await resolveSupportResults({ results: [{ message: { content: 'Hola' } }] }, read);
    expect(read).not.toHaveBeenCalled();
  });

  it('bounds recovery and rejects unfinished output', async () => {
    const read = jest.fn().mockResolvedValue({ status: 'running', results: [{ message: { content: 'Partial' } }] });
    expect(await resolveSupportResults({ results: [] }, read)).toBeNull();
    expect(read).toHaveBeenCalledTimes(3);
  });

  it.each(['', '   ', 'No response generated', ' NO RESPONSE GENERATED.! '])(
    'blocks invalid text before any persistence, including social comments: %s', async content => {
      await expect(saveMessages('user', 'Hola', content, 'conversation', undefined,
        undefined, undefined, undefined, 'site', undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, { source: 'comment' }))
        .rejects.toThrow('CUSTOMER_SUPPORT_EMPTY_RESPONSE');
      expect(supabaseAdmin.from).not.toHaveBeenCalled();
      expect(supabaseAdmin.schema).not.toHaveBeenCalled();
      expect(saveCommentMessages).not.toHaveBeenCalled();
    },
  );
});