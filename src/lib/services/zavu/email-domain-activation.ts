import { getEmailDomain } from "./client";
import { isChannelActivationBlocked } from "./channel-activation";
import { activateChannelConnection } from "./connection-activation";

/** Resume only setup explicitly left pending for this domain; never bulk-enable old accounts. */
export async function activateVerifiedEmailConnections(siteId: string, domainId: string, connections: any[]) {
  const pending = connections.filter((connection) => connection.type === "email"
    && connection.zavu_sender_id && connection.metadata?.email_domain_id === domainId
    && connection.metadata?.activation_pending === true && !isChannelActivationBlocked(connection));
  if (!pending.length) return;
  const domain = await getEmailDomain(domainId);
  if (domain?.id !== domainId || domain?.status !== "verified") return;
  for (const connection of pending) {
    await activateChannelConnection(siteId, connection.id, { senderId: connection.zavu_sender_id, type: "email" });
  }
}