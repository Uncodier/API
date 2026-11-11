import { supabaseAdmin } from '@/lib/database/supabase-client';
import { requireSavedOutboundMedia } from '../saved-outbound-media';
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/security/safe-remote-url', () => ({ assertSafeRemoteUrl: jest.fn(async (url: string) => new URL(url)) }));
const input = { site_id: 'site', conversation_id: 'conversation', message_id: 'saved', message: '' };
const media = { messageType: 'image' as const, content: { mediaUrl: 'https://media.example.test/photo.png' } };
let saved: any;
let eq: jest.Mock;
beforeEach(() => {
  jest.clearAllMocks();
  saved = { role: 'assistant', content: '', conversation_id: 'conversation', custom_data: {
    message_type: 'image', media_url: media.content.mediaUrl, status: 'sending', connection_id: 'selected',
  } };
  const query: any = { select: () => query, eq: jest.fn(() => query), maybeSingle: async () => ({ data: saved }) };
  eq = query.eq;
  jest.mocked(supabaseAdmin.from).mockReturnValue(query);
});
it('checks tenant scope and returns persisted account metadata for media-only delivery', async () => {
  expect(await requireSavedOutboundMedia(input, 'telegram', media)).toMatchObject({ connection_id: 'selected' });
  expect(eq).toHaveBeenCalledWith('conversations.site_id', 'site');
});
it.each(['role', 'content', 'conversation', 'pending', 'media'])('rejects changed or unapproved %s before delivery', async changed => {
  if (changed === 'role') saved.role = 'user';
  if (changed === 'content') saved.content = 'changed';
  if (changed === 'conversation') saved.conversation_id = 'foreign';
  if (changed === 'pending') saved.custom_data.status = 'pending';
  if (changed === 'media') saved.custom_data.media_url = 'https://media.example.test/other.png';
  await expect(requireSavedOutboundMedia(input, 'telegram', media)).rejects.toMatchObject({ status: 400 });
});
it('allows a matching persisted human attachment but never an inbound user file', async () => {
  saved.role = 'team_member';
  expect(await requireSavedOutboundMedia(input, 'telegram', media)).toBeDefined();
});
it('does not query for standalone attachment sends', async () => {
  expect(await requireSavedOutboundMedia({ site_id: 'site', message: '' }, 'telegram', media)).toBeUndefined();
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
});
it.each(['whatsapp', 'instagram', 'email'])('rejects a persisted %s attachment sent through another channel', async channel => {
  saved.custom_data.channel = channel;
  await expect(requireSavedOutboundMedia(input, 'telegram', media)).rejects.toThrow('channel must match');
});
it('uses authoritative conversation channel when message metadata has no channel', async () => {
  saved.conversations = { site_id: 'site', channel: 'whatsapp' };
  await expect(requireSavedOutboundMedia(input, 'telegram', media)).rejects.toThrow('channel must match');
});
it('does not mistake a provider provenance marker for a delivery channel', async () => {
  saved.custom_data.source = 'zavu_inbound_message';
  saved.conversations = [{ site_id: 'site', channel: 'telegram' }];
  expect(await requireSavedOutboundMedia(input, 'telegram', media)).toBeDefined();
});
it('validates legacy WhatsApp URLs against the persisted approved attachment', async () => {
  expect(await requireSavedOutboundMedia({ ...input, media_urls: [media.content.mediaUrl] }, 'whatsapp', undefined)).toBeDefined();
  await expect(requireSavedOutboundMedia({ ...input, media_urls: ['https://media.example.test/replaced.png'] }, 'whatsapp', undefined)).rejects.toThrow('saved message attachment');
  saved.custom_data.status = 'pending';
  await expect(requireSavedOutboundMedia({ ...input, media_urls: [media.content.mediaUrl] }, 'whatsapp', undefined)).rejects.toThrow('unapproved');
});
it('rejects persisted generated speech combined with an existing attachment', async () => {
  saved.custom_data.response_format = 'audio';
  await expect(requireSavedOutboundMedia(input, 'telegram', media)).rejects.toThrow('generated audio');
});