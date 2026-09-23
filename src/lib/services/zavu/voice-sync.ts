import { supabaseAdmin } from "@/lib/database/supabase-server";
import { updateAgent } from "./agent-client";
import {
  ensureSenderWebhook,
  ensureVoiceSender,
  updateSender,
} from "./client";
import {
  restoreChannelConnections,
  upsertChannelConnection,
} from "./persist";
import {
  attachCustomerSupportVoiceSenders,
  rollbackVoiceAgentSynchronization,
  syncCustomerSupportVoiceAgent,
  updateCustomerSupportVoicePrompt,
  type CustomerSupportVoiceSyncResult,
} from "./voice-agent";
import type { VoiceAgentPreferences } from "./voice-preferences";
import { syncVoiceTools } from "./voice-tools";

function parseConnections(channels: unknown): any[] {
  let parsed = channels;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  if (!parsed || typeof parsed !== "object") return [];
  const connections = (parsed as { connections?: unknown }).connections;
  return Array.isArray(connections) ? connections : [];
}

type VoiceConnection = {
  id?: string;
  type?: string;
  status?: string;
  zavu_sender_id?: string;
  metadata?: Record<string, any>;
  [key: string]: any;
};

const SYNCABLE_VOICE_STATUSES = new Set([
  "pending",
  "in_progress",
  "connected",
  "active",
  "synced",
]);
const DEFERRED_REGULATORY_STATUSES = new Set([
  "pending",
  "pending_review",
  "in_review",
  "under_review",
]);

export async function getVoiceConnectionsForSync(
  siteId: string
): Promise<VoiceConnection[]> {
  const { data, error } = await supabaseAdmin
    .from("settings")
    .select("channels")
    .eq("site_id", siteId)
    .maybeSingle();
  if (error) throw new Error("Failed to load Voice connections");

  return parseConnections(data?.channels)
    .filter(
      (connection) =>
        connection.type === "voice" &&
        SYNCABLE_VOICE_STATUSES.has(connection.status) &&
        typeof connection.zavu_sender_id === "string"
    );
}

export async function getConnectedVoiceSenderIds(siteId: string): Promise<string[]> {
  return (await getVoiceConnectionsForSync(siteId))
    .map((connection) => connection.zavu_sender_id as string);
}

export async function syncCustomerSupportVoiceAgentWithTools(params: {
  siteId: string;
  senderIds: string[];
  activate?: boolean;
  voicePreferences?: VoiceAgentPreferences;
}) {
  const synced = await syncCustomerSupportVoiceAgent({
    siteId: params.siteId,
    senderIds: params.senderIds,
    deferActivation: true,
    deferSenderAttachment: true,
    voicePreferences: params.voicePreferences,
  });
  try {
    const voiceTools = await syncVoiceTools({
      agentId: synced.agent.id,
      siteId: params.siteId,
      webhookSecret: synced.webhookSecret,
    });
    const promptedAgent = await updateCustomerSupportVoicePrompt({
      siteId: params.siteId,
      agentId: synced.agent.id,
      voicePreferences: params.voicePreferences,
      voiceTools,
    });
    const prompted = { ...synced, agent: promptedAgent };
    const attached = await attachCustomerSupportVoiceSenders(
      prompted,
      params.senderIds
    );
    if (params.activate === false) return attached;

    const agent = await updateAgent(attached.agent.id, {
      enabled: synced.shouldEnable,
    });
    return { ...attached, agent };
  } catch (error) {
    try {
      await rollbackVoiceAgentSynchronization(synced);
    } catch (rollbackError) {
      console.error(
        `[Zavu Voice] Failed to restore agent ${synced.agent.id} after tool synchronization failure:`,
        rollbackError
      );
    }
    throw error;
  }
}

function isRegulatoryActivationDeferred(connection: VoiceConnection): boolean {
  return DEFERRED_REGULATORY_STATUSES.has(
    connection.metadata?.regulatory_status
  );
}

function isRegulatoryActivationBlocked(connection: VoiceConnection): boolean {
  return (
    isRegulatoryActivationDeferred(connection) ||
    connection.metadata?.regulatory_status === "rejected"
  );
}

export interface ConnectedVoiceSyncResult {
  synced: boolean;
  agentSync?: CustomerSupportVoiceSyncResult;
  newlyEnabledSenderIds: string[];
  previousConnections: VoiceConnection[];
}

export async function rollbackConnectedVoiceAgentSync(
  siteId: string,
  result: ConnectedVoiceSyncResult
): Promise<void> {
  let rollbackFailed = false;
  const senderRollbacks = await Promise.allSettled(
    result.newlyEnabledSenderIds.map((senderId) =>
      updateSender(senderId, { enableVoice: false })
    )
  );
  for (const rollback of senderRollbacks) {
    if (rollback.status === "rejected") {
      rollbackFailed = true;
      console.error("[Zavu Voice] Failed to disable a sender during rollback:", rollback.reason);
    }
  }
  if (result.agentSync) {
    try {
      await rollbackVoiceAgentSynchronization(result.agentSync);
    } catch (error) {
      rollbackFailed = true;
      console.error("[Zavu Voice] Failed to restore the agent during rollback:", error);
    }
  }
  try {
    await restoreChannelConnections(siteId, result.previousConnections);
  } catch (error) {
    rollbackFailed = true;
    console.error("[Zavu Voice] Failed to restore Voice connections:", error);
  }
  if (rollbackFailed) {
    throw new Error("Voice synchronization rollback was incomplete");
  }
}

export async function syncConnectedCustomerSupportVoiceAgentDetailed(
  siteId: string,
  options?: { voicePreferences?: VoiceAgentPreferences }
): Promise<ConnectedVoiceSyncResult> {
  const connections = await getVoiceConnectionsForSync(siteId);
  const senderIds = Array.from(new Set(
    connections.map((connection) => connection.zavu_sender_id as string)
  ));
  if (senderIds.length === 0) {
    return {
      synced: false,
      newlyEnabledSenderIds: [],
      previousConnections: connections,
    };
  }

  const senderStates = new Map<string, any>();
  for (const senderId of senderIds) {
    senderStates.set(senderId, await ensureSenderWebhook(senderId));
  }

  let agentSync: CustomerSupportVoiceSyncResult | undefined;
  const newlyEnabledSenderIds: string[] = [];
  try {
    agentSync = await syncCustomerSupportVoiceAgentWithTools({
      siteId,
      senderIds,
      voicePreferences: options?.voicePreferences,
    });

    if (agentSync.shouldEnable) {
      for (const senderId of senderIds) {
        const senderConnections = connections.filter(
          (connection) => connection.zavu_sender_id === senderId
        );
        if (senderConnections.every(isRegulatoryActivationBlocked)) continue;
        const previous = senderStates.get(senderId);
        const wasEnabled =
          Array.isArray(previous?.channels) &&
          previous.channels.includes("voice");
        const sender = await ensureVoiceSender(senderId);
        senderStates.set(senderId, sender);
        if (!wasEnabled) newlyEnabledSenderIds.push(senderId);
      }
    }

    for (const connection of connections) {
      if (!connection.id) continue;
      const regulatoryDeferred = isRegulatoryActivationDeferred(connection);
      const regulatoryRejected =
        connection.metadata?.regulatory_status === "rejected";
      const activated = agentSync.shouldEnable && !regulatoryDeferred;
      const sender = senderStates.get(connection.zavu_sender_id as string);
      await upsertChannelConnection(siteId, connection.id, {
        status: regulatoryRejected
          ? "failed"
          : activated
            ? "connected"
            : regulatoryDeferred
              ? "in_progress"
              : "pending",
        metadata: {
          agent_enabled: agentSync.shouldEnable,
          activation_pending: !activated && !regulatoryRejected,
          zavu_agent_id: agentSync.agent.id,
          webhook_events:
            sender?.webhook?.events ||
            connection.metadata?.webhook_events ||
            [],
        },
      });
    }

    return {
      synced: true,
      agentSync,
      newlyEnabledSenderIds,
      previousConnections: connections,
    };
  } catch (error) {
    if (agentSync) {
      try {
        await rollbackConnectedVoiceAgentSync(siteId, {
          synced: false,
          agentSync,
          newlyEnabledSenderIds,
          previousConnections: connections,
        });
      } catch (rollbackError) {
        console.error("[Zavu Voice] Failed to roll back connected Voice sync:", rollbackError);
      }
    }
    throw error;
  }
}

export async function syncConnectedCustomerSupportVoiceAgent(
  siteId: string,
  options?: { voicePreferences?: VoiceAgentPreferences }
): Promise<boolean> {
  return (
    await syncConnectedCustomerSupportVoiceAgentDetailed(siteId, options)
  ).synced;
}

export async function trySyncConnectedCustomerSupportVoiceAgent(
  siteId: string
): Promise<void> {
  try {
    await syncConnectedCustomerSupportVoiceAgent(siteId);
  } catch (error) {
    console.error(
      `[Zavu Voice] Background synchronization failed for site ${siteId}:`,
      error
    );
  }
}
