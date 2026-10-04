/** Response normalization only. Provider/model fallbacks must not bypass OpenRouter. */
export function throwIfCompletionError(response: any): void {
  const detail = response?.error || response?.body?.error;
  if (!detail) return;
  const error = new Error(detail.message || 'OpenRouter completion failed');
  Object.assign(error, { status: detail.code || response?.status, code: detail.code });
  throw error;
}

export function formatOpenAiNonStreamResponse(response: any, provider: string, model: string): any {
  return {
    ...(response?.id ? { id: response.id, generationId: response.id } : {}),
    content: response?.choices?.[0]?.message?.content || '',
    // Keep all provider usage extensions, including cost, cost_details and is_byok.
    usage: response?.usage ? {
      ...response.usage,
      total_tokens: response.usage.total_tokens ??
        (response.usage.prompt_tokens || 0) + (response.usage.completion_tokens || 0),
    } : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    modelInfo: { model: response?.model || model, provider },
  };
}