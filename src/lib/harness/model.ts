import { createOpenRouterClient, getOpenRouterChatModel } from '@/lib/services/ai/openrouter';
import type { HarnessModel, Json, Message, ModelReply } from './types';
import { retryModelAdmission } from './model-admission';

export function createHarnessModel(): HarnessModel {
  const client = createOpenRouterClient({ timeout: 90000, maxRetries: 0 });
  return {
    async respond(input): Promise<ModelReply> {
      const messages = [
        { role: 'system', content: input.system },
        ...input.messages.map(message => ({
          role: message.role, content: message.content,
          ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
          ...(message.toolCalls ? { tool_calls: message.toolCalls.map(call => ({
            id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments },
          })) } : {}),
          ...(message.reasoningDetails ? { reasoning_details: message.reasoningDetails } : {}),
        })),
      ];
      // No retries around tools or accepted generations. Transport errors stay operational data.
      const response = await retryModelAdmission(() => client.chat.completions.create({
        model: getOpenRouterChatModel(), messages: messages as any,
        max_tokens: input.maxOutputTokens,
        tools: input.tools.map(tool => ({ type: 'function' as const, function: {
          name: tool.name, description: tool.description, parameters: tool.parameters,
        } })),
      }, { signal: input.signal }), input.signal);
      const choice = response.choices[0];
      if (!choice?.message) throw new Error('Model returned no assistant message');
      const raw = choice.message as typeof choice.message & { reasoning_details?: Json[] };
      const message: Message = {
        role: 'assistant', content: raw.content || '',
        ...(raw.tool_calls?.length ? { toolCalls: raw.tool_calls.map(call => ({
          id: call.id, name: call.function.name, arguments: call.function.arguments,
        })) } : {}),
        ...(Array.isArray(raw.reasoning_details) ? { reasoningDetails: raw.reasoning_details } : {}),
      };
      if (!['stop', 'tool_calls', 'length'].includes(choice.finish_reason)) {
        throw new Error(`Model response unavailable (${choice.finish_reason})`);
      }
      return { message, finishReason: choice.finish_reason as ModelReply['finishReason'],
        usage: response.usage ? { inputTokens: response.usage.prompt_tokens, outputTokens: response.usage.completion_tokens } : undefined };
    },
  };
}