import { saveMessages } from '../save-messages';
import { saveCommentMessages } from '@/lib/services/social-comments/persistence';

const mockInsert = jest.fn();
const mockResults: any[] = [];
const mockQuery: any = {};
for (const method of ['schema', 'from', 'select', 'eq']) mockQuery[method] = jest.fn(() => mockQuery);
mockQuery.insert = mockInsert.mockImplementation(() => mockQuery);
mockQuery.single = jest.fn(async () => mockResults.shift());
mockQuery.update = jest.fn(() => mockQuery);
mockQuery.then = (resolve: any) => resolve({ error: null });
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: {
  schema: (...args: any[]) => mockQuery.schema(...args),
} }));
jest.mock('../agent-data', () => ({ isValidUUID: () => true, validateLeadExists: async () => true }));
jest.mock('@/lib/services/conversation-service', () => ({ ConversationService: {} }));
jest.mock('@/lib/services/social-comments/persistence', () => ({ saveCommentMessages: jest.fn() }));
jest.mock('@/lib/security/safe-remote-url', () => ({ assertSafeRemoteUrl: jest.fn(async () => undefined) }));

beforeEach(() => { jest.clearAllMocks(); mockResults.length = 0; });

it.each([true, false])('ordinary persistence keeps assistant format and approval state (pending=%s)', async pending => {
  mockResults.push({ data: { id: 'conv' } }, { data: { custom_data: { retained: true } } },
    { data: { id: 'in' } }, { data: { id: 'out' } }, { data: { id: 'conv' } });
  const content = '  The exact spoken script.\n';
  const saved = await saveMessages('user', 'Hello', content, 'conv', undefined,
    undefined, undefined, undefined, undefined, undefined, 'telegram',
    false, false, false, undefined, true, pending, { inbound: true }, false, 'audio');
  expect(saved?.assistantMessageId).toBe('out');
  const records = mockInsert.mock.calls.map(call => call[0][0]);
  expect(records[1]).toMatchObject({ role: 'assistant', content, custom_data: { response_format: 'audio' } });
  expect(records[1].custom_data.status).toBe(pending ? 'pending' : undefined);
  expect(records[0].custom_data?.response_format).toBeUndefined();
});

it('passes selected text into the delegated social-comment save path', async () => {
  await saveMessages('user', 'Hello', 'Reply', 'conv', undefined,
    undefined, undefined, undefined, 'site', undefined, 'instagram',
    false, false, false, undefined, true, true, { source: 'comment' }, false, 'text');
  expect(saveCommentMessages).toHaveBeenCalledWith(expect.objectContaining({
    assistantMessage: 'Reply', responseFormat: 'text', metadata: { source: 'comment' },
  }));
  expect(mockInsert).not.toHaveBeenCalled();
});

it.each(['image', 'video', 'audio', 'document'])('ordinary persistence keeps existing %s and optional caption', async message_type => {
  mockResults.push({ data: { id: 'conv' } }, { data: { custom_data: {} } },
    { data: { id: 'in' } }, { data: { id: 'out' } }, { data: { id: 'conv' } });
  const media = { message_type, media_url: 'https://media.example.test/file',
    mime_type: message_type === 'document' ? 'application/pdf' : `${message_type}/test` };
  await saveMessages('user', 'Hello', '', 'conv', undefined,
    undefined, undefined, undefined, undefined, undefined, 'whatsapp',
    false, false, false, undefined, true, true, {}, false, 'text', media);
  const records = mockInsert.mock.calls.map(call => call[0][0]);
  expect(records[1]).toMatchObject({ content: '', custom_data: { ...media, response_format: 'text', status: 'pending' } });
  expect(records[0].custom_data?.media_url).toBeUndefined();
});

it('rejects speech/media conflict before writes', async () => {
  await expect(saveMessages('user', 'Hello', 'Reply', 'conv', undefined,
    undefined, undefined, undefined, undefined, undefined, 'whatsapp',
    false, false, false, undefined, true, true, {}, false, 'audio',
    { message_type: 'image', media_url: 'https://media.example.test/file' })).rejects.toThrow('combined');
  expect(mockInsert).not.toHaveBeenCalled();
});