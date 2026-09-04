type PostWithAccounts = {
  socialAccounts?: Array<{ network?: string; username?: string }>;
};

export function networksFromPost(post: PostWithAccounts | null | undefined): string[] {
  const networks = (post?.socialAccounts || [])
    .map((account) => account.network)
    .filter((value): value is string => typeof value === 'string' && value.length > 0);

  return networks.filter((network, index) => networks.indexOf(network) === index);
}

export function usernameFromPost(
  post: PostWithAccounts | null | undefined,
  network?: string
): string | undefined {
  const accounts = post?.socialAccounts || [];
  const match = network
    ? accounts.find((account) => account.network === network && account.username)
    : accounts.find((account) => Boolean(account.username));
  return match?.username;
}

export function mergeCommentResults(results: Array<Record<string, unknown>>): Record<string, unknown> {
  const replies = results.flatMap((result) => {
    if (Array.isArray(result.replies)) return result.replies;
    if (Array.isArray(result.data)) return result.data;
    return [];
  });

  const someDegraded = results.some((result) => result.degraded === true);
  const degradedWarnings = results
    .filter((result) => result.warning && typeof result.warning === 'string')
    .map((result) => result.warning);

  return {
    success: results.every((result) => result.success !== false),
    replies,
    data: replies,
    ...(someDegraded ? { degraded: true } : {}),
    ...(degradedWarnings.length > 0 ? { warning: degradedWarnings.join('; ') } : {}),
  };
}

export function emptyDegradedCommentsResult(upstreamStatus?: number, message?: string): Record<string, unknown> {
  return {
    success: true,
    replies: [],
    data: [],
    degraded: true,
    warning: message || 'Outstand failed to load comments',
    upstream_status: upstreamStatus || 500,
  };
}
