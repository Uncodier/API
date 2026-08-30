import { supabaseAdmin } from "@/lib/database/supabase-server";
import { v4 as uuidv4 } from "uuid";

export async function upsertChannelConnection(
  siteId: string,
  existingChannelId: string | undefined,
  patch: Record<string, any>
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
  const connections = Array.isArray((currentChannels as any).connections)
    ? [...(currentChannels as any).connections]
    : [];

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

  return { channelId, connection: nextConnection };
}
