import { describe, expect, it } from '@jest/globals';
import { mergeCommentResults, networksFromPost, normalizeCommentResult, usernameFromPost } from '../comments';

describe('networksFromPost', () => {
  it('returns unique networks from social accounts', () => {
    expect(
      networksFromPost({
        socialAccounts: [
          { network: 'x' },
          { network: 'linkedin' },
          { network: 'x' },
          { network: undefined },
        ],
      })
    ).toEqual(['x', 'linkedin']);
  });

  it('returns an empty list when the post has no accounts', () => {
    expect(networksFromPost(undefined)).toEqual([]);
    expect(networksFromPost({ socialAccounts: [] })).toEqual([]);
  });
});

describe('usernameFromPost', () => {
  it('returns the username for the requested network', () => {
    expect(
      usernameFromPost(
        {
          socialAccounts: [
            { network: 'x', username: 'makinari_com' },
            { network: 'facebook', username: 'Uncodie' },
          ],
        },
        'facebook'
      )
    ).toBe('Uncodie');
  });
});

describe('normalizeCommentResult', () => {
  const raw = { id: 'comment-1', text: 'Raw comment' };
  const normalized = { id: 'comment-1', content: 'Normalized comment', network: 'facebook' };

  it('preserves the provider envelope and gives normalized data priority', () => {
    const response = {
      success: true,
      replies: { comments: [raw], cursor: 'next-page' },
      data: [normalized],
    };

    expect(normalizeCommentResult(response)).toEqual(response);
  });

  it('does not fall back to raw replies when normalized data is empty', () => {
    const response = { success: true, replies: { comments: [raw] }, data: [] };

    expect(normalizeCommentResult(response)).toEqual(response);
  });

  it.each([
    { success: true, replies: [raw] },
    { success: true, replies: { comments: [raw] } },
  ])('adds canonical data without replacing raw replies: %j', (response) => {
    expect(normalizeCommentResult(response)).toEqual({ ...response, data: [raw] });
    expect(response).not.toHaveProperty('data');
  });

  it('accepts an empty raw comments collection', () => {
    expect(normalizeCommentResult({ success: true, replies: { comments: [] } })).toEqual({
      success: true,
      replies: { comments: [] },
      data: [],
    });
  });

  it.each([
    null,
    'not JSON',
    [],
    {},
    { success: true },
    { success: 'true', data: [] },
    { success: true, replies: null },
    { success: true, replies: { comments: {} } },
    { success: true, data: null, replies: [raw] },
    { success: true, data: {}, replies: { comments: [raw] } },
    { success: true, data: [null] },
    { success: true, replies: ['not a comment'] },
    { success: true, replies: { comments: [[raw]] } },
  ])('rejects malformed responses rather than inventing empty success: %j', (response) => {
    expect(() => normalizeCommentResult(response)).toThrow(
      expect.objectContaining({ status: 502 }),
    );
  });
});

describe('mergeCommentResults', () => {
  it('flattens replies from every network response', () => {
    expect(
      mergeCommentResults([
        { success: true, replies: [{ id: '1' }] },
        { success: true, data: [{ id: '2' }] },
      ])
    ).toEqual({
      success: true,
      replies: [{ id: '1' }, { id: '2' }],
      data: [{ id: '1' }, { id: '2' }],
    });
  });

  it('uses normalized data before raw replies across networks', () => {
    expect(
      mergeCommentResults([
        { success: true, replies: [{ id: 'raw-1' }], data: [{ id: 'normalized-1' }] },
        { success: true, replies: { comments: [{ id: 'raw-2' }] } },
        { success: true, replies: [{ id: 'ignored' }], data: [] },
      ])
    ).toEqual({
      success: true,
      replies: [{ id: 'normalized-1' }, { id: 'raw-2' }],
      data: [{ id: 'normalized-1' }, { id: 'raw-2' }],
    });
  });

  it.each([
    { success: false, error: 'Provider failure' },
    { success: true, data: [], degraded: true, warning: 'Partial failure' },
    { success: true, replies: {} },
  ])('rejects an unsuccessful network instead of returning partial success: %j', (failure) => {
    expect(() => mergeCommentResults([
      { success: true, data: [{ id: 'comment-1' }] },
      failure,
    ])).toThrow(expect.objectContaining({ status: 502 }));
  });
});
