import { disabledSupportNote } from '../disabled-support';
import { saveMessages } from '../save-messages';

const mockInsert = jest.fn();
const mockResults: any[] = [];
const mockQuery: any = {};
for (const method of ['schema', 'from', 'select', 'eq', 'filter', 'limit']) {
  mockQuery[method] = jest.fn(() => mockQuery);
}
mockQuery.insert = mockInsert.mockImplementation(() => mockQuery);
mockQuery.single = jest.fn(async () => mockResults.shift());
mockQuery.maybeSingle = jest.fn(async () => mockResults.shift());
mockQuery.update = jest.fn(() => Promise.resolve({ error: null }));
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { schema: (...args: any[]) => mockQuery.schema(...args) },
}));
jest.mock('../agent-data', () => ({ isValidUUID: () => true, validateLeadExists: async () => true }));
jest.mock('@/lib/services/conversation-service', () => ({ ConversationService: {} }));
jest.mock('@/lib/services/social-comments/persistence', () => ({ saveCommentMessages: jest.fn() }));

describe('disabled support persistence', () => {
  beforeEach(() => { jest.clearAllMocks(); mockResults.length = 0; });
  it.each(['en', 'es', 'fr', 'de', 'ja'])('uses the configured site locale %s', async locale => {
    mockResults.push({ data: { default_locale: locale }, error: null });
    const note = await disabledSupportNote('site');
    expect(note).toBeTruthy();
    if (locale !== 'en') expect(note).not.toContain('Customer support');
    if (locale === 'en') expect(note).toContain('No automatic response will be sent.');
    if (locale === 'es') expect(note).toContain('No se enviará ninguna respuesta automática.');
    expect(mockQuery.eq).toHaveBeenCalledWith('site_id', 'site');
  });
  it('writes the inbound message and a system-only internal note', async () => {
    mockResults.push({ data: { id: 'conv' } }, { data: { id: 'in' } },
      { data: { id: 'note' } }, { data: { id: 'conv' } });
    const saved = await saveMessages('user', 'Hello', 'Agent disabled', 'conv',
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      false, false, false, undefined, false, false, undefined, true);
    expect(saved?.userMessageId).toBe('in');
    const records = mockInsert.mock.calls.map(call => call[0][0]);
    expect(records.map(record => record.role)).toEqual(['user', 'system']);
    expect(records[1].custom_data).toMatchObject({ internal: true, response_skipped: true });
  });
  it('reuses a skipped provider message on retry without inserting anything', async () => {
    mockResults.push({ data: { id: 'conv' } }, { data: { id: 'existing' } });
    const saved = await saveMessages('user', 'Hello', 'Agent disabled', 'conv',
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      false, false, false, 'provider-id', false, false, undefined, true);
    expect(saved?.userMessageId).toBe('existing');
    expect(mockInsert).not.toHaveBeenCalled();
  });
});