import type { AgentModelType } from './types';

/** Decode the legacy family:model field without truncating OpenRouter :free/:nitro variants. */
export function parseAgentModel(value: string, fallbackType: AgentModelType = 'openrouter') {
  const match = /^(openrouter|openai|anthropic|gemini):(.+)$/.exec(value);
  return match
    ? { modelType: match[1] as AgentModelType, modelId: match[2] }
    : { modelType: fallbackType, modelId: value };
}