import { supabaseAdmin } from "@/lib/database/supabase-server";
import { refreshSiteConfigurationCaches } from "@/lib/services/site-configuration-cache";
import { activateVerifiedEmailConnections } from "./email-domain-activation";

function sameAssociation(connection: any, original: any) {
  return connection.id === original.id
    && connection.type === original.type
    && connection.zavu_sender_id === original.zavu_sender_id
    && connection.zavu_invitation_id === original.zavu_invitation_id
    && connection.created_at === original.created_at
    && connection.metadata?.email_domain_id === original.metadata?.email_domain_id;
}

/** Called only after webhook authentication; retry against fresh, existing associations. */
export async function handleDomainStatusChanged(data: any, eventType: string) {
  const domainId = data.domainId || data.id;
  if (!domainId) return;
  const status = eventType === "domain.verified" ? "verified" : "failed";
  const { data: sites, error } = await supabaseAdmin.from("settings")
    .select("id, site_id, channels")
    .contains("channels", { connections: [{ metadata: { email_domain_id: domainId } }] });
  if (error) throw error;

  for (const site of sites || []) {
    const originals = (Array.isArray(site.channels?.connections) ? site.channels.connections : [])
      .filter((connection: any) => connection.metadata?.email_domain_id === domainId);
    let snapshot = site;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        const { data: fresh, error: readError } = await supabaseAdmin.from("settings")
          .select("id, site_id, channels").eq("site_id", site.site_id).maybeSingle();
        if (readError) throw readError;
        if (!fresh || fresh.id !== site.id) break;
        snapshot = fresh;
      }
      const current = snapshot.channels?.connections;
      if (!Array.isArray(current)) break;
      let changed = false;
      const connections = current.map((connection: any) => {
        // Setup may attach its newly created sender while this event is in flight.
        // Retry the signed event with that association rather than acknowledge it
        // without saving, or transfer this snapshot's update to a new sender.
        if (connection.zavu_sender_id && originals.some((original: any) =>
          !original.zavu_sender_id
          && sameAssociation({ ...connection, zavu_sender_id: original.zavu_sender_id }, original))) {
          throw new Error("Domain status sender attached concurrently; retry webhook");
        }
        if (!originals.some((original: any) => sameAssociation(connection, original))) return connection;
        changed = true;
        return { ...connection, metadata: { ...connection.metadata, domain_status: status },
          updated_at: new Date().toISOString() };
      });
      if (!changed) break;
      const { data: saved, error: writeError } = await supabaseAdmin.from("settings")
        .update({ channels: { ...snapshot.channels, connections } })
        .eq("site_id", site.site_id).eq("id", site.id)
        .eq("channels", JSON.stringify(snapshot.channels)).select("channels").maybeSingle();
      if (writeError) throw writeError;
      if (saved) {
        await refreshSiteConfigurationCaches(site.site_id);
        if (status === "verified") {
          await activateVerifiedEmailConnections(site.site_id, domainId, saved.channels.connections);
        }
        break;
      }
      if (attempt === 2) throw new Error("Domain status settings changed concurrently");
    }
  }
}