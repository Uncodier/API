import crypto from "crypto";
import { AgentService } from "@/lib/agentbase/adapters/AgentService";
import { FileProcessingService } from "@/lib/agentbase/services/FileProcessingService";
import { BackgroundBuilder } from "@/lib/agentbase/services/agent/BackgroundServices/BackgroundBuilder";
import { DataFetcher } from "@/lib/agentbase/services/agent/BackgroundServices/DataFetcher";
import { supabaseAdmin } from "@/lib/database/supabase-server";
import { resolveClientTimezone } from "@/lib/timezone";
import { decryptToken } from "@/lib/utils/token-decryption";
import { encryptToken } from "@/lib/utils/token-encryption";
import { attachSenderToAgent, detachSenderFromAgent } from "./client";
import {
  createStandaloneAgent,
  getAgent,
  getSenderAgent,
  updateAgent,
  type ZavuAgent,
  type ZavuAgentInput,
} from "./agent-client";
import {
  buildVoiceRuntimePrompt,
  VOICE_RUNTIME_REMINDER,
  type VoicePromptTool,
} from "./voice-tools";
import {
  AUTO_VOICE_LANGUAGE,
  mergeVoiceAgentPreferences,
  readVoiceAgentPreferences,
  type VoiceAgentPreferences,
  type VoiceAgentPreferencesPatch,
} from "./voice-preferences";

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

export function fitZavuSystemPrompt(
  prompt: string,
  preservedSuffix = ""
): string {
  const requiredSuffix = preservedSuffix
    ? `\n\n${preservedSuffix}`
    : "";
  const completePrompt = `${prompt}${requiredSuffix}`;
  if (completePrompt.length <= MAX_SYSTEM_PROMPT_LENGTH) return completePrompt;

  const omission = "\n\n[Additional business context omitted due to provider limits.]";
  const reserved = `${omission}${requiredSuffix}`;
  if (reserved.length >= MAX_SYSTEM_PROMPT_LENGTH) {
    return reserved.slice(reserved.length - MAX_SYSTEM_PROMPT_LENGTH);
  }
  return `${prompt.slice(0, MAX_SYSTEM_PROMPT_LENGTH - reserved.length)}${reserved}`;
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
  agent: CustomerSupportAgent,
  options?: {
    voicePreferences?: VoiceAgentPreferences;
    voiceTools?: readonly VoicePromptTool[];
  }
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

  const runtimePrompt = buildVoiceRuntimePrompt(
    options?.voicePreferences || readVoiceAgentPreferences(agent.configuration),
    options?.voiceTools
  );
  return fitZavuSystemPrompt(
    `${runtimePrompt}\n\n${background}`,
    VOICE_RUNTIME_REMINDER
  );
}

function storedZavuAgentId(agent: CustomerSupportAgent): string | undefined {
  const value = agent.configuration?.zavu?.agent_id;
  return typeof value === "string" && value ? value : undefined;
}

export function buildZavuAgentInput(
  localAgent: CustomerSupportAgent,
  systemPrompt: string,
  voicePreferences = readVoiceAgentPreferences(localAgent.configuration)
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
      ...(voicePreferences.language !== AUTO_VOICE_LANGUAGE
        ? { language: voicePreferences.language }
        : {}),
      ...(voicePreferences.ttsVoiceId
        ? { ttsVoiceId: voicePreferences.ttsVoiceId }
        : {}),
      interruptible: true,
      maxCallDurationMinutes: 15,
    },
  };
}

export interface CustomerSupportVoiceSyncResult {
  agent: ZavuAgent;
  localAgentId: string;
  webhookSecret: string;
  shouldEnable: boolean;
  previousEnabled: boolean;
  previousAgentInput: Partial<ZavuAgentInput>;
  attachedSenderIds: string[];
}

function snapshotAgentInput(agent: ZavuAgent): Partial<ZavuAgentInput> {
  return {
    ...(agent.name ? { name: agent.name } : {}),
    ...(agent.provider ? { provider: agent.provider } : {}),
    ...(agent.model ? { model: agent.model } : {}),
    ...(typeof agent.systemPrompt === "string"
      ? { systemPrompt: agent.systemPrompt }
      : {}),
    enabled: agent.enabled,
    ...(typeof agent.contextWindowMessages === "number"
      ? { contextWindowMessages: agent.contextWindowMessages }
      : {}),
    ...(typeof agent.includeContactMetadata === "boolean"
      ? { includeContactMetadata: agent.includeContactMetadata }
      : {}),
    ...(agent.maxTokens !== undefined ? { maxTokens: agent.maxTokens } : {}),
    ...(agent.temperature !== undefined
      ? { temperature: agent.temperature }
      : {}),
    ...(Array.isArray(agent.triggerOnChannels)
      ? { triggerOnChannels: agent.triggerOnChannels }
      : {}),
    ...(Array.isArray(agent.triggerOnMessageTypes)
      ? { triggerOnMessageTypes: agent.triggerOnMessageTypes }
      : {}),
    voice: agent.voice ? { ...agent.voice } : { enabled: false },
  };
}

export async function rollbackVoiceAgentSynchronization(
  synced: Pick<
    CustomerSupportVoiceSyncResult,
    "agent" | "previousAgentInput" | "attachedSenderIds"
  >
): Promise<void> {
  const detachResults = await Promise.allSettled(
    [...synced.attachedSenderIds]
      .reverse()
      .map((senderId) => detachSenderFromAgent(senderId, synced.agent.id))
  );
  for (const result of detachResults) {
    if (result.status === "rejected") {
      console.error(
        `[Zavu Voice] Failed to detach a newly attached sender from agent ${synced.agent.id}:`,
        result.reason
      );
    }
  }
  await updateAgent(synced.agent.id, synced.previousAgentInput);
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

export async function getCustomerSupportVoicePreferences(
  siteId: string
): Promise<VoiceAgentPreferences> {
  const agent = await loadCustomerSupportAgent(siteId);
  return readVoiceAgentPreferences(agent.configuration);
}

export async function updateCustomerSupportVoicePreferences(
  siteId: string,
  patch: VoiceAgentPreferencesPatch
): Promise<VoiceAgentPreferences> {
  const agent = await loadCustomerSupportAgent(siteId);
  const preferences = mergeVoiceAgentPreferences(
    readVoiceAgentPreferences(agent.configuration),
    patch
  );
  const configuration = {
    ...(agent.configuration || {}),
    zavu: {
      ...(agent.configuration?.zavu || {}),
      voice: {
        ...(agent.configuration?.zavu?.voice || {}),
        language: preferences.language,
        ttsVoiceId: preferences.ttsVoiceId || null,
      },
    },
  };
  const { error } = await supabaseAdmin
    .from("agents")
    .update({ configuration })
    .eq("id", agent.id);
  if (error) throw new Error("Failed to save Voice agent preferences");
  return preferences;
}

export async function updateCustomerSupportVoicePrompt(params: {
  siteId: string;
  agentId: string;
  voicePreferences?: VoiceAgentPreferences;
  voiceTools: readonly VoicePromptTool[];
}): Promise<ZavuAgent> {
  const localAgent = await loadCustomerSupportAgent(params.siteId);
  const systemPrompt = await buildCustomerSupportBackground(
    params.siteId,
    localAgent,
    {
      voicePreferences: params.voicePreferences,
      voiceTools: params.voiceTools,
    }
  );
  return updateAgent(params.agentId, { systemPrompt });
}

export async function attachCustomerSupportVoiceSenders(
  synced: CustomerSupportVoiceSyncResult,
  senderIds: string[]
): Promise<CustomerSupportVoiceSyncResult> {
  for (const senderId of Array.from(new Set(senderIds.filter(Boolean)))) {
    try {
      const current = await getSenderAgent(senderId);
      if (current.id !== synced.agent.id) {
        throw new Error(
          `Sender ${senderId} already belongs to another Zavu agent`
        );
      }
    } catch (error: any) {
      if (error?.status !== 404) throw error;
      await attachSenderToAgent(senderId, synced.agent.id);
      synced.attachedSenderIds.push(senderId);
    }
  }
  return synced;
}

export async function syncCustomerSupportVoiceAgent(params: {
  siteId: string;
  senderIds: string[];
  deferActivation?: boolean;
  deferSenderAttachment?: boolean;
  voicePreferences?: VoiceAgentPreferences;
}): Promise<CustomerSupportVoiceSyncResult> {
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
  const voicePreferences =
    params.voicePreferences ||
    readVoiceAgentPreferences(localAgent.configuration);
  const systemPrompt = await buildCustomerSupportBackground(
    params.siteId,
    localAgent,
    { voicePreferences }
  );
  const desired = buildZavuAgentInput(
    localAgent,
    systemPrompt,
    voicePreferences
  );

  let zavuAgent: ZavuAgent | null = null;
  let createdAgent = false;
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

  const shouldEnable = localAgent.status === "active";
  if (!zavuAgent) {
    zavuAgent = await createStandaloneAgent({
      ...desired,
      enabled: params.deferActivation ? false : shouldEnable,
    });
    createdAgent = true;
  }

  const previousEnabled = zavuAgent.enabled === true;
  const previousAgentInput = createdAgent
    ? { ...desired, enabled: false }
    : snapshotAgentInput(zavuAgent);
  const attachedSenderIds: string[] = [];
  try {
    zavuAgent = await updateAgent(zavuAgent.id, {
      ...desired,
      enabled: params.deferActivation && shouldEnable
        ? previousEnabled
        : shouldEnable,
    });

    for (const senderId of senderIds) {
      try {
        const current = await getSenderAgent(senderId);
        if (current.id !== zavuAgent.id) {
          throw new Error(`Sender ${senderId} already belongs to another Zavu agent`);
        }
      } catch (error: any) {
        if (error?.status !== 404) throw error;
        if (!params.deferSenderAttachment) {
          await attachSenderToAgent(senderId, zavuAgent.id);
          attachedSenderIds.push(senderId);
        }
      }
    }

    await persistZavuAgentId(localAgent, zavuAgent.id, encryptToken(webhookSecret));
  } catch (error) {
    try {
      await rollbackVoiceAgentSynchronization({
        agent: zavuAgent,
        previousAgentInput,
        attachedSenderIds,
      });
    } catch (rollbackError) {
      console.error(
        `[Zavu Voice] Failed to restore agent ${zavuAgent.id} after synchronization failure:`,
        rollbackError
      );
    }
    throw error;
  }

  return {
    agent: zavuAgent,
    localAgentId: localAgent.id,
    webhookSecret,
    shouldEnable,
    previousEnabled,
    previousAgentInput,
    attachedSenderIds,
  };
}
