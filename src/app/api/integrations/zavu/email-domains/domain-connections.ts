import { isIP } from "node:net";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/database/supabase-server";
import { refreshSiteConfigurationCaches } from "@/lib/services/site-configuration-cache";

type JsonObject = Record<string, unknown>;
type Connection = JsonObject & { metadata?: JsonObject };
type Snapshot = {
  exists: boolean;
  channels: JsonObject | [] | null;
  connections: Connection[];
};

export class DomainConnectionConflict extends Error {}

// Provider IDs are used in URL paths; never allow path/query delimiters.
export const domainIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);

export function normalizeEmailDomain(value: string): string | null {
  const domain = value.trim().toLowerCase().replace(/\.$/, "");
  if (domain.length > 253 || isIP(domain)) return null;
  const labels = domain.split(".");
  if (labels.length < 2 || !/[a-z]/.test(labels[labels.length - 1])) return null;
  return labels.every((label) =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
  ) ? domain : null;
}

export const emailDomainProviderSchema = z.object({
  id: domainIdSchema,
  domain: z.string().transform(normalizeEmailDomain),
  status: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  dnsRecords: z.array(z.record(z.unknown())).default([]),
});

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Call only after requireZavuSiteManager has authorized this exact site.
export async function loadDomainConnections(siteId: string): Promise<Snapshot> {
  const { data, error } = await supabaseAdmin.from("settings")
    .select("channels").eq("site_id", siteId).maybeSingle();
  if (error) throw new Error("Could not load site settings");
  const channels: unknown = data?.channels ?? null;
  // settings.channels historically defaults to an empty JSON array.
  const emptyDefault = Array.isArray(channels) && channels.length === 0;
  if (channels !== null && !isObject(channels) && !emptyDefault) {
    throw new Error("Invalid site channels");
  }
  const connections = isObject(channels) ? channels.connections ?? [] : [];
  if (!Array.isArray(connections) || connections.some((connection) =>
    !isObject(connection) ||
    (connection.metadata != null && !isObject(connection.metadata))
  )) {
    throw new Error("Invalid site connections");
  }
  return { exists: Boolean(data), channels: channels as Snapshot["channels"], connections };
}

export function selectDomainId(
  connections: Connection[], channelId: string, domain: string
): string | undefined {
  const targets = connections.filter((connection) => connection.id === channelId);
  if (targets.length > 1) throw new DomainConnectionConflict();
  const target = targets[0];
  const routing = target?.metadata?.routing;
  if (target && (target.type !== "email" || target.zavu_sender_id ||
      target.metadata?.sender_id || target.metadata?.zavu_sender_id ||
      (isObject(routing) && routing.sender_id))) {
    throw new DomainConnectionConflict();
  }

  const ids = new Set<string>();
  for (const connection of connections) {
    const metadata = connection.metadata;
    if (connection.type !== "email" || typeof metadata?.domain !== "string" ||
        normalizeEmailDomain(metadata.domain) !== domain || !metadata.email_domain_id) continue;
    const parsed = domainIdSchema.safeParse(metadata.email_domain_id);
    if (!parsed.success) throw new DomainConnectionConflict();
    ids.add(parsed.data);
  }
  if (ids.size > 1) throw new DomainConnectionConflict();
  return ids.values().next().value;
}

export async function saveDomainFields(
  siteId: string,
  channelId: string,
  name: string | undefined,
  snapshot: Snapshot,
  emailDomain: { id: string; domain: string; status: string; dnsRecords: JsonObject[] }
): Promise<void> {
  const connections = [...snapshot.connections];
  const index = connections.findIndex((connection) => connection.id === channelId);
  const previous = index >= 0 ? connections[index] : null;
  const connection = {
    // Existing connections keep their identity, status, receiving, activation,
    // manual-disabled state and timestamps. Only domain metadata is changed.
    ...(previous ?? { id: channelId, type: "email", name: name || "Email Channel", status: "pending" }),
    metadata: {
      ...previous?.metadata,
      email_domain_id: emailDomain.id,
      domain: emailDomain.domain,
      domain_status: emailDomain.status,
      dns_records: emailDomain.dnsRecords,
    },
  };
  if (index >= 0) connections[index] = connection;
  else connections.push(connection);
  const channels = { ...snapshot.channels, connections };

  if (snapshot.exists) {
    let query = supabaseAdmin.from("settings").update({ channels }).eq("site_id", siteId);
    // Compare-and-swap the entire JSON snapshot, so a concurrent sender creation
    // or independent state update cannot be silently overwritten.
    query = snapshot.channels === null
      ? query.is("channels", null)
      : query.eq("channels", JSON.stringify(snapshot.channels));
    const { data, error } = await query.select("site_id").maybeSingle();
    if (error) throw new Error("Could not update site settings");
    if (!data) throw new DomainConnectionConflict();
  } else {
    const { error } = await supabaseAdmin.from("settings").insert({ site_id: siteId, channels });
    if (error?.code === "23505") throw new DomainConnectionConflict();
    if (error) throw new Error("Could not create site settings");
  }
  await refreshSiteConfigurationCaches(siteId);
}