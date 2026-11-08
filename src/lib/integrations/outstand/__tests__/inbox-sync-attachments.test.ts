import { supabaseAdmin } from '@/lib/database/supabase-client';
import { recordOutstandMessage } from '../inbox-sync';
import type { OutstandConversation, OutstandConversationMessage } from '../types';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('../client', () => ({ getOutstandClient: jest.fn(() => { throw new Error('No provider calls allowed'); }) }));
jest.mock('@/lib/services/leads/outstand-dm-identity', () => ({
  ensureOutstandDmLead: jest.fn(async () => ({
    leadId: 'lead-1', identity: { socialAccountId: 'account-1', participantId: 'participant-1', username: 'alice' },
  })),
}));

function query(data: unknown) {
  const result: any = { error: null };
  for (const method of ['select', 'eq', 'filter', 'is', 'update', 'insert']) {
    result[method] = jest.fn(() => result);
  }
  result.maybeSingle = jest.fn(async () => ({ data, error: null }));
  return result;
}

const conversation = {
  id: 'dm-1', network: 'instagram', socialAccountId: 'account-1', participantId: 'participant-1', status: 'active',
} as OutstandConversation;
const image = 'https://example.com/image.jpg';

describe.each(['insert', 'update'] as const)('Outstand attachment %s', mode => {
  beforeEach(() => {
    jest.clearAllMocks();
    (supabaseAdmin.from as jest.Mock).mockReset();
  });

  it.each([
    { name: 'text and media', content: 'Photo', mediaUrls: [image, image], urls: [image] },
    { name: 'media only', content: null, mediaUrls: [image], urls: [image] },
    { name: 'invalid URLs', content: '', mediaUrls: ['not a URL', 'file:///tmp/a', 'https://user:pass@example.com/a', image], urls: [image] },
    { name: 'only invalid URLs', content: '', mediaUrls: ['data:image/png;base64,x'], urls: [] },
    { name: 'no media', content: 'Hello', mediaUrls: [], urls: [] },
  ])('persists normalized attachments for $name and retains media_urls', async ({ content, mediaUrls, urls }) => {
    const mutation = query({ id: 'message-1' });
    (supabaseAdmin.from as jest.Mock)
      .mockReturnValueOnce(query({ id: 'local-dm', user_id: 'owner', lead_id: 'lead-1', title: 'Alice', custom_data: {} }))
      .mockReturnValueOnce(query({ id: 'local-dm' }))
      .mockReturnValueOnce(query(mode === 'update' ? {
        id: 'message-1', custom_data: { keep: true, status: 'sent', attachments: [{ url: 'https://example.com/old.jpg' }] },
      } : null))
      .mockReturnValueOnce(mutation);
    const message: OutstandConversationMessage = {
      id: 'provider-message', conversationId: 'dm-1', platformMessageId: null,
      direction: 'inbound', senderId: 'participant-1', content, mediaUrls, status: 'sent',
      error: null, scheduledAt: null, platformSentAt: null, createdAt: '2026-01-01T00:00:00Z',
    };

    await recordOutstandMessage(message, conversation, 'site-1');

    const payload = mode === 'insert' ? mutation.insert.mock.calls[0][0][0] : mutation.update.mock.calls[0][0];
    expect(payload.content).toBe(content || '');
    expect(payload.custom_data.media_urls).toEqual(mediaUrls);
    expect(payload.custom_data.attachments).toEqual(urls.map(url => ({
      url, mimeType: undefined, name: undefined, type: undefined,
    })));
    if (mode === 'update') expect(payload.custom_data.keep).toBe(true);
  });
});
