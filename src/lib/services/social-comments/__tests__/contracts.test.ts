import { database } from './database';
import { commentConversationId, commentMetadata, conversationMetadata, replyMetadata } from '../metadata';
import { ensureCommentConversation, bindCommentAgent } from '../conversations';
import { findCommentProposal, saveCommentMessages } from '../persistence';
import { interventionCommentMetadata, loadSavedCommentReply } from '../reply-target';
import { sendCommentReply } from '../delivery';
import { authorizeCommentAccount } from '../ownership';
import { supabaseAdmin } from '@/lib/database/supabase-client';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('../ownership', () => ({ authorizeCommentAccount: jest.fn() }));
jest.mock('uuid', () => {
  const v5 = (value: string) => require('node:crypto').createHash('sha256').update(value).digest('hex');
  v5.URL = 'test-namespace';
  return { v5 };
});

const siteId = '00000000-0000-4000-8000-000000000001';
const base = {
  source: 'comment', channel: 'instagram', network: 'instagram', publisher_account_id: 'account-a',
  publisher_username: 'owned-account', outstand_post_id: 'post-a', platform_post_id: 'platform-post-a',
  platform_comment_id: 'comment-a', author_id: 'author-a', author_name: 'Commenter',
  author_identity_status: 'available', parent_comment_id: 'parent-not-target',
};
let db: ReturnType<typeof database>;
let publish: jest.Mock;

beforeEach(() => {
  db = database();
  (supabaseAdmin.from as jest.Mock).mockImplementation(db.from);
  db.tables.sites.push({ id: siteId, user_id: 'site-owner' });
  publish = jest.fn().mockResolvedValue({ success: true, reply_id: 'provider-reply' });
  (authorizeCommentAccount as jest.Mock).mockResolvedValue({ client: { publishComment: publish },
    username: 'verified-owned-account', platformPostId: base.platform_post_id });
});

async function persist(metadata: Record<string, any> = { ...base }) {
  const conversationId = await ensureCommentConversation({ siteId, metadata });
  const ids = await saveCommentMessages({ siteId, conversationId, metadata, userId: 'site-owner',
    userMessage: 'A question', assistantMessage: 'Answer', agentId: 'agent-a' });
  return { ...ids, metadata };
}

it('groups the same author/post forever, but isolates site, network, account, post and author', () => {
  const id = commentConversationId(siteId, base);
  expect(commentConversationId(siteId, { ...base, platform_comment_id: 'second-comment' })).toBe(id);
  for (const key of ['network', 'publisher_account_id', 'outstand_post_id', 'author_id']) {
    expect(commentConversationId(siteId, { ...base, [key]: 'other' })).not.toBe(id);
  }
  expect(commentConversationId('other-site', base)).not.toBe(id);
});

it('never groups unknown authors by names or publisher and never persists LinkedIn profiles', () => {
  const anonymous = { ...base, author_id: undefined };
  expect(commentConversationId(siteId, anonymous)).not.toBe(commentConversationId(siteId, { ...anonymous, platform_comment_id: 'other' }));
  expect(conversationMetadata(anonymous).comment_grouping_version).toBeUndefined();
  const linkedIn = commentMetadata({ ...base, network: 'linkedin', channel: 'linkedin', author_username: 'hidden', profile_url: 'https://example.invalid/profile' })!;
  expect(linkedIn.author_name).toBeUndefined();
  expect(linkedIn.author_identity_status).toBe('resolve_on_read');
  expect(conversationMetadata(linkedIn).author_username).toBeUndefined();
  expect(commentMetadata({ source: 'outstand_dm' })).toBeNull();
});

it('creates one conversation and one inbound/proposal pair under concurrent first sighting', async () => {
  const results = await Promise.all([persist(), persist()]);
  expect(results[0].conversationId).toBe(results[1].conversationId);
  expect(db.tables.conversations).toHaveLength(1);
  expect(db.tables.messages).toHaveLength(2);
  const proposal = db.tables.messages.find(row => row.role === 'assistant')!;
  expect(proposal.custom_data).toMatchObject({ source: 'comment', status: 'pending',
    reply_to_message_id: results[0].userMessageId, reply_to_comment_id: 'comment-a' });
  await bindCommentAgent(siteId, results[0].conversationId, 'resolved-agent');
  expect(db.tables.conversations[0].agent_id).toBe('resolved-agent');
});

it('reuses closed/old canonical conversations without altering legacy messages or pending proposals', async () => {
  const first = await persist();
  db.tables.conversations[0].status = 'closed';
  db.tables.messages[1].content = 'Manually edited proposal';
  db.tables.conversations.push({ id: 'legacy', site_id: siteId, channel: 'instagram' });
  await persist();
  expect(db.tables.conversations).toHaveLength(2);
  expect(db.tables.messages[1].content).toBe('Manually edited proposal');
  expect(await findCommentProposal(siteId, base)).toMatchObject({ userMessageId: first.userMessageId });
  await expect(ensureCommentConversation({ siteId, metadata: { ...base }, conversationId: 'legacy' })).rejects.toThrow('scope');
});

it('recovers a partial inbound save and fails closed on a database lookup error', async () => {
  await persist();
  db.tables.messages.pop();
  expect(await findCommentProposal(siteId, base)).toBeNull();
  await persist();
  expect(db.tables.messages).toHaveLength(2);
  db.failNext('messages');
  await expect(findCommentProposal(siteId, base)).rejects.toThrow('lookup failed');
});

it('uses verified local post text; rejects cross-site previews and never downloads arbitrary URLs', async () => {
  db.tables.content.push({ id: 'content-a', site_id: siteId, title: 'Post title', text: 'Post body',
    metadata: { outstand_post_ids: ['post-a'] } });
  const result = await persist({ ...base, content_id: 'content-a', platform_post_url: 'javascript:alert(1)' });
  expect(db.tables.conversations[0].custom_data).toMatchObject({ post_title: 'Post title', post_text: 'Post body' });
  expect(result.metadata.platform_post_url).toBeUndefined();
});

it('manual reply requires a selected source; rejects cross-conversation, non-comment and DM targets', async () => {
  const ids = await persist();
  const input = { siteId, conversationId: ids.conversationId, userId: 'team-user', conversationData: { source: 'comment' } };
  await expect(interventionCommentMetadata(input)).rejects.toThrow('required');
  const metadata = await interventionCommentMetadata({ ...input, replyToMessageId: ids.userMessageId });
  expect(metadata?.reply_to_comment_id).toBe('comment-a');
  await expect(interventionCommentMetadata({ ...input, replyToMessageId: 'foreign-message' })).rejects.toThrow('inbound');
  db.tables.conversations[0].custom_data = { source: 'outstand_dm', outstand_conversation_id: 'dm' };
  await expect(interventionCommentMetadata({ ...input, replyToMessageId: ids.userMessageId })).rejects.toThrow('mismatch');
});

it('retains manual targets on retry, rejects changes and allows explicitly selected legacy sources', async () => {
  const ids = await persist();
  db.tables.conversations[0].custom_data = {};
  db.tables.messages.push({ id: 'manual', conversation_id: ids.conversationId, role: 'team_member', user_id: 'team',
    custom_data: { ...replyMetadata(base, ids.userMessageId), status: 'failed' } });
  const input = { siteId, conversationId: ids.conversationId, conversationData: {}, userId: 'team', retryMessageId: 'manual' };
  expect((await interventionCommentMetadata(input))?.reply_to_message_id).toBe(ids.userMessageId);
  await expect(interventionCommentMetadata({ ...input, replyToMessageId: 'other' })).rejects.toThrow('cannot change');
  await expect(interventionCommentMetadata({ ...input, retryMessageId: undefined })).rejects.toThrow('explicit');
});

it('delivers to the explicit original comment after a newer inbound arrives, not its parent or commenter username', async () => {
  const first = await persist();
  db.tables.messages.find(row => row.id === first.assistantMessageId)!.custom_data.status = 'accepted';
  await persist({ ...base, platform_comment_id: 'newer-comment' });
  const params = { site_id: siteId, conversation_id: first.conversationId, message_id: first.assistantMessageId,
    channel: 'instagram', message: 'Answer' };
  await sendCommentReply(params);
  await sendCommentReply(params);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenCalledWith('post-a', expect.objectContaining({
    parent_comment_id: 'comment-a', account_username: 'verified-owned-account',
  }), siteId);
});

it('fails closed for a legacy untargeted proposal, foreign site, changed network, or changed source', async () => {
  const first = await persist();
  await expect(loadSavedCommentReply('other-site', first.conversationId, first.assistantMessageId, 'instagram')).rejects.toThrow();
  await expect(loadSavedCommentReply(siteId, first.conversationId, first.assistantMessageId, 'linkedin')).rejects.toThrow('mismatch');
  db.tables.messages[1].custom_data.reply_to_comment_id = 'wrong';
  await expect(loadSavedCommentReply(siteId, first.conversationId, first.assistantMessageId, 'instagram')).rejects.toThrow('mismatch');
  delete db.tables.messages[1].custom_data.reply_to_message_id;
  await expect(loadSavedCommentReply(siteId, first.conversationId, first.assistantMessageId, 'instagram')).rejects.toThrow('explicit');
});

it('never resends an ambiguous provider call even if an external worker marks generic status failed', async () => {
  const ids = await persist();
  db.tables.messages.find(row => row.id === ids.assistantMessageId)!.custom_data.status = 'accepted';
  const params = { site_id: siteId, conversation_id: ids.conversationId, message_id: ids.assistantMessageId,
    channel: 'instagram', message: 'Answer' };
  publish.mockRejectedValue(new Error('Timeout'));
  await expect(sendCommentReply(params)).rejects.toThrow('unconfirmed');
  db.tables.messages[1].custom_data.status = 'failed';
  await expect(sendCommentReply(params)).rejects.toThrow('reconciliation');
  expect(publish).toHaveBeenCalledTimes(1);
});

it('claims one delivery across concurrent calls', async () => {
  const ids = await persist();
  db.tables.messages.find(row => row.id === ids.assistantMessageId)!.custom_data.status = 'accepted';
  const params = { site_id: siteId, conversation_id: ids.conversationId, message_id: ids.assistantMessageId,
    channel: 'instagram', message: 'Answer' };
  const results = await Promise.allSettled([sendCommentReply(params), sendCommentReply(params)]);
  expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1);
  expect(publish).toHaveBeenCalledTimes(1);
});

it('never delivers an unapproved proposal or a draft edited while provider ownership is checked', async () => {
  const ids = await persist();
  const params = { site_id: siteId, conversation_id: ids.conversationId, message_id: ids.assistantMessageId,
    channel: 'instagram', message: 'Answer' };
  await expect(sendCommentReply(params)).rejects.toThrow('requires approval');
  expect(publish).not.toHaveBeenCalled();
  const outgoing = db.tables.messages.find(row => row.id === ids.assistantMessageId)!;
  outgoing.custom_data.status = 'accepted';
  (authorizeCommentAccount as jest.Mock).mockImplementationOnce(async () => {
    outgoing.content = 'New edited answer';
    return { client: { publishComment: publish }, username: 'verified-owned-account', platformPostId: base.platform_post_id };
  });
  await expect(sendCommentReply(params)).rejects.toThrow('could not be claimed');
  expect(publish).not.toHaveBeenCalled();
});