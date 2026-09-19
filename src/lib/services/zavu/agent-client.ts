import { zavuFetch } from "./client";

export interface ZavuAgent {
  id: string;
  name: string;
  enabled: boolean;
  senderId?: string;
  senderIds?: string[];
  systemPrompt: string;
}

export interface ZavuAgentInput {
  name: string;
  provider: "zavu";
  model: string;
  systemPrompt: string;
  enabled?: boolean;
  contextWindowMessages?: number;
  includeContactMetadata?: boolean;
  triggerOnChannels?: string[];
  triggerOnMessageTypes?: string[];
  voice?: {
    enabled: boolean;
    greeting?: string;
    language?: string;
    interruptible?: boolean;
    maxCallDurationMinutes?: number;
  };
}

export interface ZavuAgentToolInput {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  webhookUrl: string;
  webhookSecret: string;
  enabled?: boolean;
}

export interface ZavuAgentTool extends ZavuAgentToolInput {
  id: string;
  agentId: string;
}

function unwrapAgent(payload: any): ZavuAgent {
  const agent = payload?.agent || payload;
  if (!agent?.id) throw new Error("Zavu agent response is missing id");
  return agent;
}

export async function getSenderAgent(senderId: string): Promise<ZavuAgent> {
  return unwrapAgent(await zavuFetch(`/senders/${encodeURIComponent(senderId)}/agent`));
}

export async function getAgent(agentId: string): Promise<ZavuAgent> {
  return unwrapAgent(await zavuFetch(`/agents/${encodeURIComponent(agentId)}`));
}

export async function createStandaloneAgent(params: ZavuAgentInput): Promise<ZavuAgent> {
  return unwrapAgent(
    await zavuFetch("/agents", {
      method: "POST",
      body: JSON.stringify(params),
    })
  );
}

export async function updateAgent(
  agentId: string,
  params: Partial<ZavuAgentInput>
): Promise<ZavuAgent> {
  return unwrapAgent(
    await zavuFetch(`/agents/${encodeURIComponent(agentId)}`, {
      method: "PATCH",
      body: JSON.stringify(params),
    })
  );
}

export async function listAgentTools(agentId: string): Promise<ZavuAgentTool[]> {
  const payload = await zavuFetch<any>(
    `/agents/${encodeURIComponent(agentId)}/tools?limit=100`
  );
  return payload?.items || payload?.tools || (Array.isArray(payload) ? payload : []);
}

export async function upsertAgentTool(
  agentId: string,
  params: ZavuAgentToolInput
): Promise<ZavuAgentTool> {
  const tools = await listAgentTools(agentId);
  const existing = tools.find((tool) => tool.name === params.name);
  const path = existing
    ? `/agents/${encodeURIComponent(agentId)}/tools/${encodeURIComponent(existing.id)}`
    : `/agents/${encodeURIComponent(agentId)}/tools`;
  const payload = await zavuFetch<any>(path, {
    method: existing ? "PATCH" : "POST",
    body: JSON.stringify({ ...params, enabled: params.enabled ?? true }),
  });
  return payload?.tool || payload;
}

export async function deleteAgentTool(agentId: string, toolId: string): Promise<void> {
  await zavuFetch(
    `/agents/${encodeURIComponent(agentId)}/tools/${encodeURIComponent(toolId)}`,
    { method: "DELETE" }
  );
}
