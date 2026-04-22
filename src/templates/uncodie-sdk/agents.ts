import type { UncodieClient } from './client';

export interface InvokeAgentInput {
  tool: string;
  input: Record<string, unknown>;
}

export function createAgentsModule(client: UncodieClient) {
  return {
    invoke(params: InvokeAgentInput): Promise<unknown> {
      if (!params.tool) throw new Error('[uncodie.agents] `tool` is required.');
      return client.post(`agents/invoke/${params.tool}`, params.input);
    },
  };
}
