import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getConversationsCore } from '@/app/api/agents/customerSupport/conversations/core';
import { conversationsTool } from '../assistantProtocol';

jest.mock('@/app/api/agents/customerSupport/conversations/core', () => ({
  getConversationsCore: jest.fn(),
}));

const SITE_ID = '00000000-0000-4000-8000-000000000001';
const USER_ID = '00000000-0000-4000-8000-000000000002';

describe('conversations tool site scope', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getConversationsCore as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        conversations: [],
        pagination: { total: 0, page: 1, limit: 10, pages: 0 },
      },
    } as never);
  });

  it('does not hide company conversations behind the agent user id', async () => {
    await conversationsTool(SITE_ID, USER_ID).execute({ action: 'list' });

    expect(getConversationsCore).toHaveBeenCalledWith(expect.objectContaining({
      site_id: SITE_ID,
      user_id: undefined,
    }));
  });

  it('keeps an explicit user filter when requested', async () => {
    await conversationsTool(SITE_ID, USER_ID).execute({
      action: 'list',
      user_id: USER_ID,
    });

    expect(getConversationsCore).toHaveBeenCalledWith(expect.objectContaining({
      site_id: SITE_ID,
      user_id: USER_ID,
    }));
  });
});
