import { supabaseAdmin } from "@/lib/database/supabase-server";
import { updateAgent } from "./agent-client";
import { ensureSenderWebhook } from "./client";
import { syncCustomerSupportVoiceAgent } from "./voice-agent";
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

export async function getConnectedVoiceSenderIds(siteId: string): Promise<string[]> {
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
        ["connected", "active", "in_progress", "synced"].includes(connection.status) &&
        typeof connection.zavu_sender_id === "string"
    )
    .map((connection) => connection.zavu_sender_id);
}

export async function syncCustomerSupportVoiceAgentWithTools(params: {
  siteId: string;
  senderIds: string[];
  activate?: boolean;
}) {
  const synced = await syncCustomerSupportVoiceAgent({
    siteId: params.siteId,
    senderIds: params.senderIds,
    deferActivation: true,
  });
  try {
    await syncVoiceTools({
      agentId: synced.agent.id,
      siteId: params.siteId,
      webhookSecret: synced.webhookSecret,
    });
    if (params.activate === false) return synced;

    const agent = await updateAgent(synced.agent.id, {
      enabled: synced.shouldEnable,
    });
    return { ...synced, agent };
  } catch (error) {
    try {
      await updateAgent(synced.agent.id, { enabled: synced.previousEnabled });
    } catch (rollbackError) {
      console.error(
        `[Zavu Voice] Failed to restore agent ${synced.agent.id} after tool synchronization failure:`,
        rollbackError
      );
    }
    throw error;
  }
}

export async function syncConnectedCustomerSupportVoiceAgent(
  siteId: string
): Promise<boolean> {
  const senderIds = await getConnectedVoiceSenderIds(siteId);
  if (senderIds.length === 0) return false;

  await Promise.all(senderIds.map((senderId) => ensureSenderWebhook(senderId)));
  await syncCustomerSupportVoiceAgentWithTools({ siteId, senderIds });
  return true;
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
