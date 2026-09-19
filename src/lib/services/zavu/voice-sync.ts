import { supabaseAdmin } from "@/lib/database/supabase-server";
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

export async function syncConnectedCustomerSupportVoiceAgent(
  siteId: string
): Promise<boolean> {
  const senderIds = await getConnectedVoiceSenderIds(siteId);
  if (senderIds.length === 0) return false;

  const synced = await syncCustomerSupportVoiceAgent({ siteId, senderIds });
  await syncVoiceTools({
    agentId: synced.agent.id,
    siteId,
    webhookSecret: synced.webhookSecret,
  });
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
