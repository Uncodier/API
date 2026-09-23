import { zavuFetch } from "./client";
import type { ZavuAgentVoiceCatalog } from "./voice-preferences";

export type ZavuAgentProvider =
  | "openai"
  | "anthropic"
  | "google"
  | "mistral"
  | "zavu";

export interface ZavuAgentVoiceConfig {
  enabled: boolean;
  greeting?: string;
  language?: string;
  ttsVoiceId?: string;
  interruptible?: boolean;
  maxCallDurationMinutes?: number;
}

export interface ZavuAgent {
  id: string;
  name: string;
  enabled: boolean;
  senderId?: string;
  senderIds?: string[];
  systemPrompt: string;
  provider?: ZavuAgentProvider;
  model?: string;
  contextWindowMessages?: number;
  includeContactMetadata?: boolean;
  maxTokens?: number | null;
  temperature?: number | null;
  triggerOnChannels?: string[];
  triggerOnMessageTypes?: string[];
  voice?: ZavuAgentVoiceConfig;
}

export interface ZavuAgentInput {
  name: string;
  provider: ZavuAgentProvider;
  model: string;
  systemPrompt: string;
  enabled?: boolean;
  contextWindowMessages?: number;
  includeContactMetadata?: boolean;
  maxTokens?: number | null;
  temperature?: number | null;
  triggerOnChannels?: string[];
  triggerOnMessageTypes?: string[];
  voice?: ZavuAgentVoiceConfig;
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
  const payload = await zavuFetch<any>(
    `/senders/${encodeURIComponent(senderId)}/agent`
  );
  if (payload?.agent === null) {
    const error = new Error("Zavu agent not found");
    (error as Error & { status: number }).status = 404;
    throw error;
  }
  return unwrapAgent(payload);
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

export async function listAgentVoices(
  language?: string
): Promise<ZavuAgentVoiceCatalog> {
  const search = new URLSearchParams();
  if (language) search.set("language", language);
  const query = search.size ? `?${search.toString()}` : "";
  const payload = await zavuFetch<ZavuAgentVoiceCatalog>(
    `/agents/voices${query}`
  );
  return {
    items: Array.isArray(payload?.items) ? payload.items : [],
    languages: Array.isArray(payload?.languages) ? payload.languages : [],
    ...(typeof payload?.total === "number" ? { total: payload.total } : {}),
  };
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
