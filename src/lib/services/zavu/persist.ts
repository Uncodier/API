import { supabaseAdmin } from "@/lib/database/supabase-server";
import { refreshSiteConfigurationCaches } from "@/lib/services/site-configuration-cache";
import { v4 as uuidv4 } from "uuid";
import type { VoiceAgentPreferences } from "./voice-preferences";

export async function getChannelConnection(siteId: string, channelId: string | undefined) {
  if (!channelId) return null;

  const { data: settingsRow, error } = await supabaseAdmin
    .from("settings")
    .select("channels")
    .eq("site_id", siteId)
    .maybeSingle();

  if (error) {
    console.error("[Zavu] Error fetching channel connection:", error);
    return null;
  }

  const connections = (settingsRow?.channels as any)?.connections || [];
  return connections.find((c: any) => c.id === channelId) || null;
}

function replaceSenderReferences(
  connections: any[],
  previousSenderId: string,
  replacementSenderId: string
): { changed: boolean; connections: any[] } {
  let changed = false;
  const nextConnections = connections.map((connection: any) => {
    const metadata = connection.metadata || {};
    const routing = metadata.routing || {};
    const referencesPreviousSender =
      connection.zavu_sender_id === previousSenderId ||
      metadata.sender_id === previousSenderId ||
      routing.sender_id === previousSenderId;
    if (!referencesPreviousSender) return connection;

    changed = true;
    return {
      ...connection,
      ...(connection.zavu_sender_id === previousSenderId
        ? { zavu_sender_id: replacementSenderId }
        : {}),
      metadata: {
        ...metadata,
        ...(metadata.sender_id === previousSenderId
          ? { sender_id: replacementSenderId }
          : {}),
        ...(metadata.routing
          ? {
              routing: {
                ...routing,
                ...(routing.sender_id === previousSenderId
                  ? { sender_id: replacementSenderId }
                  : {}),
              },
            }
          : {}),
      },
      updated_at: new Date().toISOString(),
    };
  });

  return { changed, connections: nextConnections };
}

export async function replaceChannelSenderReferences(
  siteId: string,
  previousSenderId: string,
  replacementSenderId: string
): Promise<void> {
  const { data: settingsRow, error: settingsError } = await supabaseAdmin
    .from("settings")
    .select("channels")
    .eq("site_id", siteId)
    .maybeSingle();

  if (settingsError) {
    throw new Error("Failed to fetch site settings");
  }
  if (!settingsRow) return;

  const currentChannels = settingsRow.channels || {};
  const currentConnections = Array.isArray((currentChannels as any).connections)
    ? (currentChannels as any).connections
    : [];
  const { changed, connections } = replaceSenderReferences(
    currentConnections,
    previousSenderId,
    replacementSenderId
  );

  if (!changed) return;
  const { error: updateError } = await supabaseAdmin
    .from("settings")
    .update({ channels: { ...currentChannels, connections } })
    .eq("site_id", siteId);
  if (updateError) {
    throw new Error("Failed to replace obsolete sender references");
  }
  await refreshSiteConfigurationCaches(siteId);
}

export async function upsertChannelConnection(
  siteId: string,
  existingChannelId: string | undefined,
  patch: Record<string, any>,
  options?: {
    replaceSender?: {
      previousSenderId: string;
      replacementSenderId: string;
    };
  }
) {
  const { data: settingsRow, error: settingsError } = await supabaseAdmin
    .from("settings")
    .select("id, channels")
    .eq("site_id", siteId)
    .maybeSingle();

  if (settingsError) {
    throw new Error("Failed to fetch site settings");
  }

  const currentChannels = settingsRow?.channels || {};
  let connections = Array.isArray((currentChannels as any).connections)
    ? [...(currentChannels as any).connections]
    : [];
  if (options?.replaceSender) {
    connections = replaceSenderReferences(
      connections,
      options.replaceSender.previousSenderId,
      options.replaceSender.replacementSenderId
    ).connections;
  }

  const now = new Date().toISOString();
  const existingIndex = existingChannelId
    ? connections.findIndex((item: any) => item.id === existingChannelId)
    : -1;
  const channelId = existingChannelId || uuidv4();
  const previous = existingIndex >= 0 ? connections[existingIndex] : {};

  const nextConnection = {
    ...previous,
    ...patch,
    id: channelId,
    metadata: {
      ...(previous.metadata || {}),
      ...(patch.metadata || {}),
    },
    created_at: previous.created_at || now,
    updated_at: now,
  };

  if (existingIndex >= 0) {
    connections[existingIndex] = nextConnection;
  } else {
    connections.push(nextConnection);
  }

  const updatedChannels = { ...currentChannels, connections };
  const { error: updateError } = settingsRow
    ? await supabaseAdmin
        .from("settings")
        .update({ channels: updatedChannels })
        .eq("site_id", siteId)
    : await supabaseAdmin
        .from("settings")
        .insert({ site_id: siteId, channels: updatedChannels });

  if (updateError) {
    throw new Error("Failed to save connection in database");
  }
  await refreshSiteConfigurationCaches(siteId);

  return { channelId, connection: nextConnection, connections };
}

export async function updateAllVoiceConnectionPreferences(
  siteId: string,
  preferences: VoiceAgentPreferences
): Promise<{ connections: any[] }> {
  const { data: settingsRow, error: settingsError } = await supabaseAdmin
    .from("settings")
    .select("channels")
    .eq("site_id", siteId)
    .maybeSingle();
  if (settingsError) {
    throw new Error("Failed to fetch site settings");
  }
  if (!settingsRow) {
    throw new Error("Site settings not found");
  }

  const currentChannels = settingsRow.channels || {};
  const currentConnections = Array.isArray((currentChannels as any).connections)
    ? (currentChannels as any).connections
    : [];
  const now = new Date().toISOString();
  const connections = currentConnections.map((connection: any) =>
    connection.type === "voice"
      ? {
          ...connection,
          metadata: {
            ...(connection.metadata || {}),
            voice_language: preferences.language,
            tts_voice_id: preferences.ttsVoiceId || null,
          },
          updated_at: now,
        }
      : connection
  );

  const { error: updateError } = await supabaseAdmin
    .from("settings")
    .update({
      channels: {
        ...(currentChannels as Record<string, unknown>),
        connections,
      },
    })
    .eq("site_id", siteId);
  if (updateError) {
    throw new Error("Failed to save Voice preferences on channel connections");
  }
  await refreshSiteConfigurationCaches(siteId);
  return { connections };
}

export async function restoreChannelConnections(
  siteId: string,
  snapshots: any[]
): Promise<{ connections: any[] }> {
  if (snapshots.length === 0) return { connections: [] };
  const { data: settingsRow, error: settingsError } = await supabaseAdmin
    .from("settings")
    .select("channels")
    .eq("site_id", siteId)
    .maybeSingle();
  if (settingsError || !settingsRow) {
    throw new Error("Failed to fetch site settings");
  }

  const currentChannels = settingsRow.channels || {};
  const currentConnections = Array.isArray((currentChannels as any).connections)
    ? (currentChannels as any).connections
    : [];
  const snapshotsById = new Map(
    snapshots
      .filter((connection) => connection?.id)
      .map((connection) => [connection.id, connection])
  );
  const connections = currentConnections.map(
    (connection: any) => snapshotsById.get(connection.id) || connection
  );

  const { error: updateError } = await supabaseAdmin
    .from("settings")
    .update({
      channels: {
        ...(currentChannels as Record<string, unknown>),
        connections,
      },
    })
    .eq("site_id", siteId);
  if (updateError) {
    throw new Error("Failed to restore Voice channel connections");
  }
  await refreshSiteConfigurationCaches(siteId);
  return { connections };
}
