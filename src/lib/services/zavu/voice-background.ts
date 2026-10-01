import { AgentService } from "@/lib/agentbase/adapters/AgentService";
import { FileProcessingService } from "@/lib/agentbase/services/FileProcessingService";
import { BackgroundBuilder } from "@/lib/agentbase/services/agent/BackgroundServices/BackgroundBuilder";
import { DataFetcher } from "@/lib/agentbase/services/agent/BackgroundServices/DataFetcher";
import { resolveClientTimezone } from "@/lib/timezone";
import type { CustomerSupportAgent } from "./voice-agent";
import { readVoiceAgentPreferences, type VoiceAgentPreferences } from "./voice-preferences";
import { composeVoiceSystemPrompt } from "./voice-prompt-budget";
import { buildVoiceBusinessBrief } from "./voice-business-brief";
import { buildVoiceRuntimePrompt, VOICE_RUNTIME_REMINDER, type VoicePromptTool } from "./voice-tools";

const fileProcessingService = new FileProcessingService();

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function enabledNames(values: Record<string, any> | null): string[] {
  if (!values) return [];
  return Object.entries(values)
    .filter(([, value]) => value?.enabled === true || value?.status === "available")
    .map(([key, value]) => text(value?.name, key));
}

/** Reuse AgentBase's stable sources; no caller, lead or contextual factors are required. */
export async function buildCustomerSupportBackground(
  siteId: string,
  agent: CustomerSupportAgent,
  options?: {
    voicePreferences?: VoiceAgentPreferences;
    voiceTools?: readonly VoicePromptTool[];
  }
): Promise<string> {
  const [siteInfo, activeCampaigns, timezone, linkedFiles] = await Promise.all([
    DataFetcher.getSiteInfo(siteId),
    DataFetcher.getActiveCampaigns(siteId),
    resolveClientTimezone({ siteId }),
    AgentService.getAgentFiles(agent.id),
  ]);
  const configuration = agent.configuration || {};
  const configuredCapabilities = Array.isArray(configuration.capabilities)
    ? configuration.capabilities.filter((value: unknown): value is string =>
        typeof value === "string" && Boolean(value.trim()))
    : [];
  const capabilities = [
    ...enabledNames(agent.tools),
    ...enabledNames(agent.activities),
    ...configuredCapabilities,
  ];

  // Match AgentBase's configuration-over-row precedence without serializing private configuration.
  let background = BackgroundBuilder.buildAgentPrompt(
    agent.id,
    agent.name,
    text(configuration.description, agent.description || ""),
    Array.from(new Set(capabilities)),
    text(configuration.backstory, agent.backstory || ""),
    text(configuration.systemPrompt),
    text(configuration.prompt, agent.prompt),
    siteInfo,
    activeCampaigns,
    timezone
  );

  const configuredFiles = Array.isArray(configuration.contextFiles)
    ? configuration.contextFiles
    : [];
  const files = [...(linkedFiles || []), ...configuredFiles]
    .filter((file) => file && typeof file === "object")
    .map((file) => ({ ...file, file_path: file.file_path || file.path }))
    .filter((file, index, all) =>
      all.findIndex((candidate) =>
        (file.id && candidate.id === file.id) ||
        (file.file_path && candidate.file_path === file.file_path)
      ) === index
    );
  if (files.length > 0) {
    background = await fileProcessingService.appendAgentFilesToBackground(background, files);
  }

  return composeVoiceSystemPrompt({
    runtime: buildVoiceRuntimePrompt(
      options?.voicePreferences || readVoiceAgentPreferences(configuration),
      options?.voiceTools
    ),
    background,
    businessBrief: buildVoiceBusinessBrief(siteInfo, agent.name),
    reminder: VOICE_RUNTIME_REMINDER,
    timezone,
  });
}