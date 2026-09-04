import { mergeCommentResults, networksFromPost, usernameFromPost, emptyDegradedCommentsResult } from '../comments';

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

  it('merges degraded status and warnings when present', () => {
    expect(
      mergeCommentResults([
        { success: true, replies: [{ id: '1' }] },
        emptyDegradedCommentsResult(502, 'Facebook failed'),
      ])
    ).toEqual({
      success: true,
      replies: [{ id: '1' }],
      data: [{ id: '1' }],
      degraded: true,
      warning: 'Facebook failed',
    });
  });
});

describe('emptyDegradedCommentsResult', () => {
  it('returns a successful empty list with degraded flag', () => {
    expect(emptyDegradedCommentsResult(500)).toEqual({
      success: true,
      replies: [],
      data: [],
      degraded: true,
      warning: 'Outstand failed to load comments',
      upstream_status: 500,
    });
  });
});
