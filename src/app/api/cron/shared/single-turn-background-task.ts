export interface SingleTurnBackgroundTask {
  pid: string;
  logFile: string;
  toolCallId: string;
}

export interface SingleTurnBackgroundState {
  sleepRequested?: number;
  backgroundTask?: SingleTurnBackgroundTask;
}

function parseToolContent(content: unknown): Record<string, unknown> | null {
  try {
    const value = typeof content === 'string' ? JSON.parse(content) : content;
    return value && typeof value === 'object' ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function extractSingleTurnBackgroundState(result: any): SingleTurnBackgroundState {
  const lastMessage = result.messages?.[result.messages.length - 1];
  if (lastMessage?.role !== 'tool') return {};
  const parsed = parseToolContent(lastMessage.content);
  if (!parsed) return {};

  if (lastMessage.name === 'sandbox_start_background_command') {
    if (!parsed.success || !parsed.pid || !parsed.log_file) return {};
    return {
      backgroundTask: {
        pid: String(parsed.pid),
        logFile: String(parsed.log_file),
        toolCallId: String(lastMessage.tool_call_id),
      },
    };
  }

  if (lastMessage.name !== 'sandbox_check_background_command' || parsed.is_running !== true) {
    return {};
  }

  const toolCalls = result.steps?.[result.steps.length - 1]?.toolCalls;
  const call = toolCalls?.find(
    (candidate: any) => candidate.toolCallId === lastMessage.tool_call_id,
  );
  const backgroundTask = call?.args?.pid && call?.args?.log_file
    ? {
        pid: String(call.args.pid),
        logFile: String(call.args.log_file),
        toolCallId: String(lastMessage.tool_call_id),
      }
    : undefined;

  return { sleepRequested: 15, backgroundTask };
}
