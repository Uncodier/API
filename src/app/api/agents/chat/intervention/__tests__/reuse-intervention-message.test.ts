const mockFrom = jest.fn();
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: mockFrom } }));
import { reuseInterventionMessage } from '../reuse-intervention-message';

const messageId = '11111111-1111-4111-8111-111111111111';
const conversationId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';

describe('intervention retry ownership and atomic claim', () => {
  let customData: Record<string, unknown>;
  let readData: any;
  let filters: Array<[string, unknown]>;
  let claimed: boolean;
  let updates: number;
  beforeEach(() => {
    customData = { status: 'failed', command_status: 'failed', error_message: 'Old error' };
    readData = { id: messageId, conversation_id: conversationId, content: 'Hello', custom_data: customData };
    filters = [];
    claimed = true;
    updates = 0;
    mockFrom.mockImplementation(() => {
      let writing = false;
      const q: any = {
        select: () => q,
        eq: (key: string, value: unknown) => { filters.push([key, value]); return q; },
        single: async () => ({ data: readData, error: null }),
        update: (payload: any) => { writing = true; updates++; expect(payload.custom_data.error_message).toBeUndefined(); return q; },
        maybeSingle: async () => ({ data: writing && claimed ? { id: messageId } : null, error: null }),
      };
      return q;
    });
  });

  it('claims the unchanged failed message and scopes both reads and writes to its author', async () => {
    await expect(reuseInterventionMessage(messageId, conversationId, userId, 'Hello')).resolves.toMatchObject({ interventionMessageId: messageId });
    expect(filters).toContainEqual(['custom_data', JSON.stringify(customData)]);
    expect(filters.filter(([key]) => key === 'user_id')).toEqual([['user_id', userId], ['user_id', userId]]);
  });

  it('allows the legacy pending status with a failed command marker', async () => {
    customData.status = 'pending';
    await expect(reuseInterventionMessage(messageId, conversationId, userId, 'Hello')).resolves.not.toBeNull();
  });

  it('rejects a concurrent claim without starting another send', async () => {
    claimed = false;
    await expect(reuseInterventionMessage(messageId, conversationId, userId, 'Hello')).resolves.toBeNull();
  });

  it.each([
    { status: 'sent' }, { status: 'delivered' }, { status: 'placement_unknown' },
    { status: 'queued' }, { status: 'running' }, { command_status: 'success' },
    { provider_call_id: 'call' }, { call_status: 'queued' }, { call_status: 'placement_unknown' },
  ])('never retries advanced delivery state %j', async (extra) => {
    Object.assign(customData, extra);
    await expect(reuseInterventionMessage(messageId, conversationId, userId, 'Hello')).resolves.toBeNull();
    expect(updates).toBe(0);
  });

  it('rejects changed content or a missing author-scoped row', async () => {
    await expect(reuseInterventionMessage(messageId, conversationId, userId, 'Different')).resolves.toBeNull();
    readData = null;
    await expect(reuseInterventionMessage(messageId, conversationId, userId, 'Hello')).resolves.toBeNull();
    expect(updates).toBe(0);
  });
});