import crypto from "crypto";
import { AgentService } from "@/lib/agentbase/adapters/AgentService";
import { FileProcessingService } from "@/lib/agentbase/services/FileProcessingService";
import { BackgroundBuilder } from "@/lib/agentbase/services/agent/BackgroundServices/BackgroundBuilder";
import { DataFetcher } from "@/lib/agentbase/services/agent/BackgroundServices/DataFetcher";
import { supabaseAdmin } from "@/lib/database/supabase-server";
import { resolveClientTimezone } from "@/lib/timezone";
import { decryptToken } from "@/lib/utils/token-decryption";
import { encryptToken } from "@/lib/utils/token-encryption";
import { attachSenderToAgent } from "./client";
import {
  createStandaloneAgent,
  getAgent,
  getSenderAgent,
  updateAgent,
  type ZavuAgent,
  type ZavuAgentInput,
} from "./agent-client";

const CUSTOMER_SUPPORT_ROLE = "Customer Support";
const MAX_SYSTEM_PROMPT_LENGTH = 10_000;
const fileProcessingService = new FileProcessingService();

export type CustomerSupportAgent = {
  id: string;
  name: string;
  description: string | null;
  prompt: string;
  backstory: string | null;
  status: string;
  tools: Record<string, any> | null;
  activities: Record<string, any> | null;
  configuration: Record<string, any> | null;
};

function enabledNames(values: Record<string, any> | null): string[] {
  if (!values) return [];
  return Object.entries(values)
    .filter(([, value]) => value?.enabled === true || value?.status === "available")
    .map(([key, value]) => value?.name || key);
}

export function fitZavuSystemPrompt(prompt: string): string {
  if (prompt.length <= MAX_SYSTEM_PROMPT_LENGTH) return prompt;
  const suffix = "\n\n[Additional business context omitted due to provider limits.]";
  return `${prompt.slice(0, MAX_SYSTEM_PROMPT_LENGTH - suffix.length)}${suffix}`;
}

async function loadCustomerSupportAgent(siteId: string): Promise<CustomerSupportAgent> {
  const { data, error } = await supabaseAdmin
    .from("agents")
    .select("id, name, description, prompt, backstory, status, tools, activities, configuration")
    .eq("site_id", siteId)
    .eq("role", CUSTOMER_SUPPORT_ROLE)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error("Failed to load the Customer Support agent");
  if (!data) throw new Error("Customer Support agent not found");
  return data as CustomerSupportAgent;
}

export async function buildCustomerSupportBackground(
  siteId: string,
  agent: CustomerSupportAgent
): Promise<string> {
  const siteInfo = await DataFetcher.getSiteInfo(siteId);
  const activeCampaigns = await DataFetcher.getActiveCampaigns(siteId);
  const timezone = await resolveClientTimezone({ siteId });
  const capabilities = [
    ...enabledNames(agent.tools),
    ...enabledNames(agent.activities),
  ];

  let background = BackgroundBuilder.buildAgentPrompt(
    agent.id,
    agent.name,
    agent.description || "",
    Array.from(new Set(capabilities)),
    agent.backstory || undefined,
    undefined,
    agent.prompt,
    siteInfo,
    activeCampaigns,
    timezone
  );

  const linkedFiles = (await AgentService.getAgentFiles(agent.id)) || [];
  const configuredFiles = Array.isArray(agent.configuration?.contextFiles)
    ? agent.configuration.contextFiles
    : [];
  const files = [...linkedFiles, ...configuredFiles]
    .map((file: any) => ({
      ...file,
      file_path: file.file_path || file.path,
    }))
    .filter(
      (file: any, index, all) =>
        all.findIndex(
          (candidate: any) =>
            (file.id && candidate.id === file.id) ||
            (file.file_path && candidate.file_path === file.file_path)
        ) === index
    );
  if (files.length > 0) {
    background = await fileProcessingService.appendAgentFilesToBackground(
      background,
      files
    );
  }

  return fitZavuSystemPrompt(background);
}

function storedZavuAgentId(agent: CustomerSupportAgent): string | undefined {
  const value = agent.configuration?.zavu?.agent_id;
  return typeof value === "string" && value ? value : undefined;
}

export function buildZavuAgentInput(
  localAgent: CustomerSupportAgent,
  systemPrompt: string
): ZavuAgentInput {
  return {
    name: localAgent.name,
    provider: "zavu",
    model: process.env.ZAVUDEV_AGENT_MODEL || "openai/gpt-4o-mini",
    systemPrompt,
    contextWindowMessages: 20,
    includeContactMetadata: true,
    triggerOnChannels: ["voice"],
    triggerOnMessageTypes: ["text"],
    voice: {
      enabled: true,
      interruptible: true,
      maxCallDurationMinutes: 15,
    },
  };
}

async function findReusableSenderAgent(senderIds: string[]): Promise<ZavuAgent | null> {
  for (const senderId of senderIds) {
    try {
      const agent = await getSenderAgent(senderId);
      if (!agent.senderIds || agent.senderIds.length <= 1) return agent;
      throw new Error(
        `Sender ${senderId} is connected to a shared Zavu agent and cannot be adopted safely`
      );
    } catch (error: any) {
      if (error?.status !== 404) throw error;
    }
  }
  return null;
}

async function persistZavuAgentId(
  agent: CustomerSupportAgent,
  zavuAgentId: string,
  encryptedWebhookSecret: string
): Promise<void> {
  const configuration = {
    ...(agent.configuration || {}),
    zavu: {
      ...(agent.configuration?.zavu || {}),
      agent_id: zavuAgentId,
      tool_webhook_secret: encryptedWebhookSecret,
      synced_at: new Date().toISOString(),
    },
  };
  const { error } = await supabaseAdmin
    .from("agents")
    .update({ configuration })
    .eq("id", agent.id);
  if (error) throw new Error("Failed to persist the Zavu agent mapping");
}

export async function syncCustomerSupportVoiceAgent(params: {
  siteId: string;
  senderIds: string[];
}): Promise<{ agent: ZavuAgent; localAgentId: string; webhookSecret: string }> {
  const senderIds = Array.from(new Set(params.senderIds.filter(Boolean)));
  if (senderIds.length === 0) {
    throw new Error("At least one Zavu sender is required");
  }

  const localAgent = await loadCustomerSupportAgent(params.siteId);
  const encryptedSecret = localAgent.configuration?.zavu?.tool_webhook_secret;
  const existingSecret =
    typeof encryptedSecret === "string" ? decryptToken(encryptedSecret) : null;
  const webhookSecret =
    existingSecret || `whsec_${crypto.randomBytes(32).toString("base64url")}`;
  const systemPrompt = await buildCustomerSupportBackground(params.siteId, localAgent);
  const desired = buildZavuAgentInput(localAgent, systemPrompt);

  let zavuAgent: ZavuAgent | null = null;
  const configuredId = storedZavuAgentId(localAgent);
  if (configuredId) {
    try {
      zavuAgent = await getAgent(configuredId);
    } catch (error: any) {
      if (error?.status !== 404) throw error;
    }
  }

  if (!zavuAgent) {
    zavuAgent = await findReusableSenderAgent(senderIds);
  }

  if (!zavuAgent) {
    zavuAgent = await createStandaloneAgent(desired);
  }

  for (const senderId of senderIds) {
    try {
      const current = await getSenderAgent(senderId);
      if (current.id !== zavuAgent.id) {
        throw new Error(`Sender ${senderId} already belongs to another Zavu agent`);
      }
    } catch (error: any) {
      if (error?.status !== 404) throw error;
      await attachSenderToAgent(senderId, zavuAgent.id);
    }
  }

  zavuAgent = await updateAgent(zavuAgent.id, {
    ...desired,
    enabled: localAgent.status === "active",
  });
  await persistZavuAgentId(localAgent, zavuAgent.id, encryptToken(webhookSecret));

  return { agent: zavuAgent, localAgentId: localAgent.id, webhookSecret };
}
