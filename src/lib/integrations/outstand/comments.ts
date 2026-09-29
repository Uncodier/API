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

export type CommentsResult = Record<string, unknown> & {
  success: true;
  data: Array<Record<string, unknown>>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function commentsError(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 502 });
}

export function normalizeCommentResult(result: unknown): CommentsResult {
  if (!isRecord(result)) {
    throw commentsError('Invalid Outstand comments response');
  }
  if (result.success === false || result.degraded === true) {
    throw commentsError('Outstand failed to load complete comments');
  }
  if (result.success !== undefined && result.success !== true) {
    throw commentsError('Invalid Outstand comments success flag');
  }

  // Canonical data wins, even when empty. Never replace malformed data with raw replies.
  const comments = Object.prototype.hasOwnProperty.call(result, 'data')
    ? result.data
    : Array.isArray(result.replies)
      ? result.replies
      : isRecord(result.replies)
        ? result.replies.comments
        : undefined;

  if (!Array.isArray(comments) || !comments.every(isRecord)) {
    throw commentsError('Invalid Outstand comments collection');
  }

  // Keep raw replies and provider metadata intact for existing single-network callers.
  return { ...result, success: true, data: comments };
}

export function mergeCommentResults(results: unknown[]): CommentsResult {
  const comments = results.flatMap((result) => normalizeCommentResult(result).data);

  return {
    success: true,
    replies: comments,
    data: comments,
  };
}
