type HistoricalInstanceLog = {
  log_type?: unknown;
  message?: unknown;
  created_at?: unknown;
  tool_name?: unknown;
  tool_result?: unknown;
};

function generatedMediaUrls(log: HistoricalInstanceLog): string[] {
  const toolName = typeof log.tool_name === 'string' ? log.tool_name : '';
  if (toolName !== 'generate_image' && toolName !== 'generate_video') {
    return [];
  }
  const toolResult =
    log.tool_result && typeof log.tool_result === 'object'
      ? log.tool_result as Record<string, unknown>
      : null;
  const output =
    toolResult?.output && typeof toolResult.output === 'object'
      ? toolResult.output as Record<string, unknown>
      : null;
  const outputKey = toolName === 'generate_image' ? 'images' : 'videos';
  const media = output?.[outputKey];
  if (toolResult?.success !== true || !Array.isArray(media)) return [];

  return media.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const url = (item as Record<string, unknown>).url;
    return typeof url === 'string' && url.length > 0 ? [url] : [];
  });
}

export function formatRunnerExecutionHistory(rawLogs: unknown): string {
  if (!Array.isArray(rawLogs) || rawLogs.length === 0) return '';

  const lines: string[] = [];
  for (const candidate of [...rawLogs].reverse()) {
    try {
      if (!candidate || typeof candidate !== 'object') continue;
      const log = candidate as HistoricalInstanceLog;
      const createdAt = new Date(String(log.created_at || ''));
      const timestamp = Number.isNaN(createdAt.getTime())
        ? 'unknown time'
        : createdAt.toLocaleTimeString();
      const role = log.log_type === 'user_action' ? 'User' : 'Assistant';
      const rawMessage = String(log.message || '');
      const message =
        `${rawMessage.substring(0, 150)}` +
        `${rawMessage.length > 150 ? '...' : ''}`;
      const toolName =
        typeof log.tool_name === 'string' ? log.tool_name : '';
      const urls = generatedMediaUrls(log);

      lines.push(
        urls.length > 0
          ? `[${timestamp}] ${role}: Generated ${toolName} - URLs: ${urls.join(', ')}`
          : `[${timestamp}] ${role}: ${message}`,
      );
    } catch {
      // A malformed historical row must not discard requirement/backlog context.
    }
  }

  return lines.length > 0
    ? `\n\n📋 RUNNER EXECUTION HISTORY:\n${lines.join('\n')}\n`
    : '';
}
