export function matchesZavuThread(threadChannel: unknown, metadata: Record<string, unknown> | null | undefined, expected: string) {
  const channel = threadChannel ?? metadata?.channel;
  return channel === expected && (metadata?.channel == null || metadata.channel === channel)
    && !metadata?.outstand_conversation_id && !metadata?.outstand_comment_id && !metadata?.social_comment
    && !String(metadata?.source ?? '').includes('comment');
}
