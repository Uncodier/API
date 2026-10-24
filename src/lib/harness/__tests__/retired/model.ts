// Historical regression fixture only. Never import from production.
import { createOpenRouterClient, getOpenRouterChatModel } from '@/lib/services/ai/openrouter';
import type { HarnessModel, Json, Message, ModelBillingEvidence, ModelReply } from '../../types';
import { retryModelAdmission } from '../../model-admission';
import { observeCompletedTextRequest } from '@/lib/status/text-execution-observation';

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
      let rejectedAdmission = false;
      let response;
      const model = getOpenRouterChatModel();
      try { response = await observeCompletedTextRequest(model, () => retryModelAdmission(async () => {
        rejectedAdmission = false;
        try { return await client.chat.completions.create({
          model, messages: messages as any,
          max_tokens: input.maxOutputTokens,
          tools: input.tools.map(tool => ({ type: 'function' as const, function: {
            name: tool.name, description: tool.description, parameters: tool.parameters,
          } })),
        }, { signal: input.signal }); }
        catch (error) {
          const e = error as { status?: number; usage?: unknown; generationId?: unknown;
            error?: { usage?: unknown; generation_id?: unknown; metadata?: { generation_id?: unknown } } };
          rejectedAdmission = [400, 401, 402, 403, 404, 405, 409, 422, 429, 503].includes(e?.status || 0)
            && !e.usage && !e.generationId && !e.error?.usage && !e.error?.generation_id && !e.error?.metadata?.generation_id;
          throw error;
        }
      }, input.signal), { signal: input.signal }); }
      catch (error) {
        const e = error as { usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
          generationId?: string; model?: string; error?: { usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
            generation_id?: string; model?: string; metadata?: { generation_id?: string; model?: string } } };
        const usage = e?.usage || e?.error?.usage;
        const generationId = e?.generationId || e?.error?.generation_id || e?.error?.metadata?.generation_id;
        const providerModel = e?.model || e?.error?.model || e?.error?.metadata?.model;
        if (error && typeof error === 'object') Object.assign(error, {
          ...(usage ? { usage: { ...usage, inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens } } : {}),
          ...(generationId ? { generationId } : {}), ...(providerModel ? { model: providerModel } : {}),
        });
        if (rejectedAdmission && error && typeof error === 'object') Object.assign(error, { admissionRejected: true });
        throw error;
      }
      // Capture accepted-generation billing evidence BEFORE inspecting choices/tools.
      const reported = response.usage as typeof response.usage & { cost?: number };
      const evidence: ModelBillingEvidence = {
        ...(reported ? { usage: { inputTokens: reported.prompt_tokens, outputTokens: reported.completion_tokens,
          ...(Object.prototype.hasOwnProperty.call(reported, 'cost') ? { cost: reported.cost } : {}) } } : {}),
        ...(typeof response.id === 'string' ? { generationId: response.id } : {}),
        ...(typeof response.model === 'string' ? { model: response.model } : {}),
      };
      try {
        const choice = response.choices?.[0];
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
        return { message, finishReason: choice.finish_reason as ModelReply['finishReason'], ...evidence };
      } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error('Invalid model response'), evidence);
      }
    },
  };
}