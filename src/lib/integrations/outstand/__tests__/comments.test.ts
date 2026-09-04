import { mergeCommentResults, networksFromPost } from '../comments';

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
});
