import { supabaseAdmin } from "@/lib/database/supabase-server";
import { refreshSiteConfigurationCaches } from "@/lib/services/site-configuration-cache";
import { v4 as uuidv4 } from "uuid";

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
