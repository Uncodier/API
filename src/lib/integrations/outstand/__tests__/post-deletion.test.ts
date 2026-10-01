import { describe, expect, it, jest } from '@jest/globals';
import { accountsRequiringDeletion, confirmRemoteResults, deleteOwnedPost } from '../post-deletion';
import type { OwnedPost, ProviderAccount } from '../post-ownership';
import type { OutstandClient } from '../client';

const account = (id = 'a', changes: Record<string, unknown> = {}): ProviderAccount => ({
  id, network: 'x', username: id, status: 'published', platformPostId: `remote-${id}`, ...changes,
});
const post = (accounts = [account()], changes: Record<string, unknown> = {}): OwnedPost => ({
  id: 'post-1', isDraft: false, scheduledAt: null, publishedAt: null, socialAccounts: accounts, ...changes,
});
const result = (id = 'a', changes: Record<string, unknown> = {}) => ({
  network: 'x', username: id, platform_post_id: `remote-${id}`, status: 'deleted', error: null, ...changes,
});
const response = (results = [result()]) => ({ success: true, results });

describe('remote deletion account states', () => {
  it('targets published accounts, accepts per-account deleted proof and skips failed publication', () => {
    const a = account();
    expect(accountsRequiringDeletion(post([
      a, account('b', { status: 'deleted' }), account('c', { status: 'failed', platformPostId: null, publishedAt: null }),
    ]))).toEqual([a]);
  });

  it.each(['instagram', 'tiktok', 'new-network'])('rejects unsupported published network %s before mutation', (network) => {
    expect(() => accountsRequiringDeletion(post([account('a', { network })]))).toThrow(/unsupported/);
  });

  it.each(['pending', 'processing', undefined, 'already_deleted'])('rejects uncertain state %s', (status) => {
    expect(() => accountsRequiringDeletion(post([account('a', { status })]))).toThrow(/uncertain/);
  });

  it('allows a draft or sufficiently future scheduled cancellation, never an immediate/due publish', () => {
    const pending = [account('a', { status: 'pending', platformPostId: null, publishedAt: null })];
    expect(accountsRequiringDeletion(post(pending, { isDraft: true }))).toEqual([]);
    expect(accountsRequiringDeletion(post(pending, { scheduledAt: new Date(Date.now() + 300_000).toISOString() }))).toEqual([]);
    expect(() => accountsRequiringDeletion(post(pending))).toThrow(/uncertain/);
    expect(() => accountsRequiringDeletion(post(pending, { scheduledAt: new Date().toISOString() }))).toThrow(/uncertain/);
  });

  it('does not use a global draft/deleted flag to ignore published accounts', () => {
    expect(accountsRequiringDeletion(post([account()], { isDraft: true, status: 'deleted' }))).toHaveLength(1);
  });

  it('rejects mixed in-flight delivery, conflicting failed state, missing platform ID, ambiguous identities', () => {
    const pending = account('b', { status: 'pending', platformPostId: null });
    for (const accounts of [
      [account(), pending], [account('a', { status: 'failed' })], [account('a', { platformPostId: null })],
      [account(), account('b', { username: 'a' })],
    ]) expect(() => accountsRequiringDeletion(post(accounts))).toThrow(/uncertain/);
  });

  it('does not mistake omitted failed/pending publication fields for confirmed absence', () => {
    for (const status of ['failed', 'pending']) {
      expect(() => accountsRequiringDeletion(post([
        account('a', { status, platformPostId: undefined, publishedAt: null }),
      ], { isDraft: true }))).toThrow(/uncertain/);
      expect(() => accountsRequiringDeletion(post([
        account('a', { status, platformPostId: null, publishedAt: undefined }),
      ], { isDraft: true }))).toThrow(/uncertain/);
    }
  });
});

describe('complete and unambiguous per-account results', () => {
  it('requires every published account, not merely provider success=true', () => {
    const accounts = [account(), account('b')];
    expect(() => confirmRemoteResults(response(), accounts, accounts)).toThrow(/incomplete/);
    expect(() => confirmRemoteResults(response([result(), result('b')]), accounts, accounts)).not.toThrow();
  });

  it('accepts already-deleted preflight accounts omitted from results on retry', () => {
    expect(() => confirmRemoteResults(response(), [account()], [account(), account('b', { status: 'deleted' })])).not.toThrow();
  });

  it.each([
    { success: true }, { success: true, results: [] }, { success: false, results: [result()] },
    { success: true, degraded: true, results: [result()] },
    response([result('b')]), response([result(), result()]),
    response([result('a', { platform_post_id: 'wrong' })]),
    response([result('a', { platform_post_id: null })]),
    response([result('a', { error: 'provider secret' })]),
    response([result('a', { status: 'already_deleted' })]),
    response([result('a', { status: ['deleted'] })]),
    response([result('a', { error: undefined })]),
  ])('rejects malformed or incomplete result %j', (value) => {
    expect(() => confirmRemoteResults(value, [account()], [account()])).toThrow(/incomplete/);
  });

  it('treats failed/already-missing error text as a failure, never infers deletion from text', () => {
    expect(() => confirmRemoteResults(response([result('a', {
      status: 'failed', error: 'Already deleted: sensitive upstream text',
    })]), [account()], [account()])).toThrow(/one or more accounts/);
  });
});

describe('ordered deletion and manual retries', () => {
  const client = () => {
    const deleteRemotePost = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(response());
    const deletePost = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ success: true, message: 'Deleted' });
    return { deleteRemotePost, deletePost };
  };

  it('performs remote first, then record, returning confirmation markers', async () => {
    const provider = client();
    expect(await deleteOwnedPost(provider as unknown as OutstandClient, post(), 'site', true)).toEqual({
      success: true, post_id: 'post-1', delete_remote: true,
    });
    expect(provider.deleteRemotePost.mock.invocationCallOrder[0]).toBeLessThan(provider.deletePost.mock.invocationCallOrder[0]);
  });

  it('can retry after a successful remote deletion followed by record failure', async () => {
    const provider = client();
    provider.deletePost.mockRejectedValueOnce(new Error('transport secret'));
    await expect(deleteOwnedPost(provider as unknown as OutstandClient, post(), 'site', true)).rejects.toMatchObject({ status: 502 });
    await deleteOwnedPost(provider as unknown as OutstandClient, post([account('a', { status: 'deleted' })]), 'site', true);
    expect(provider.deleteRemotePost).toHaveBeenCalledTimes(1);
    expect(provider.deletePost).toHaveBeenCalledTimes(2);
  });

  it('does not invoke remote for default record-only deletion', async () => {
    const provider = client();
    await deleteOwnedPost(provider as unknown as OutstandClient, post(), 'site', false);
    expect(provider.deleteRemotePost).not.toHaveBeenCalled();
    expect(provider.deletePost).toHaveBeenCalledTimes(1);
  });

  it('never deletes record or blindly retries after remote transport uncertainty', async () => {
    const provider = client();
    provider.deleteRemotePost.mockRejectedValueOnce(new Error('transport secret'));
    await expect(deleteOwnedPost(provider as unknown as OutstandClient, post(), 'site', true)).rejects.toMatchObject({ status: 502 });
    expect(provider.deleteRemotePost).toHaveBeenCalledTimes(1);
    expect(provider.deletePost).not.toHaveBeenCalled();
  });
});