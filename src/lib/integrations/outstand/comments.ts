type PostWithAccounts = {
  socialAccounts?: Array<{ network?: string }>;
};

export function networksFromPost(post: PostWithAccounts | null | undefined): string[] {
  const networks = (post?.socialAccounts || [])
    .map((account) => account.network)
    .filter((value): value is string => typeof value === 'string' && value.length > 0);

  return networks.filter((network, index) => networks.indexOf(network) === index);
}

export function mergeCommentResults(results: Array<Record<string, unknown>>): Record<string, unknown> {
  const replies = results.flatMap((result) => {
    if (Array.isArray(result.replies)) return result.replies;
    if (Array.isArray(result.data)) return result.data;
    return [];
  });

  return {
    success: results.every((result) => result.success !== false),
    replies,
    data: replies,
  };
}
