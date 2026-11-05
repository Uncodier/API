import { supabaseAdmin } from "@/lib/database/supabase-server";
import { getInvitation, mapInvitationStatus } from "./client";
import { activateChannelConnection } from "./connection-activation";
import { isChannelActivationBlocked } from "./channel-activation";
import { getChannelConnection } from "./persist";
import { patchActivationConnection, requireActivationLicense } from "./activation-persistence";

export async function findInvitationConnection(invitationId: string, siteId?: string) {
  let query = supabaseAdmin.from("settings").select("site_id, channels")
    .contains("channels", { connections: [{ zavu_invitation_id: invitationId }] });
  if (siteId) query = query.eq("site_id", siteId);
  const { data, error } = await query;
  if (error) throw new Error("Failed to read invitation connection");
  const matches = (data || []).flatMap((site: any) =>
    (site.channels?.connections || [])
      .filter((connection: any) => connection.zavu_invitation_id === invitationId)
      .map((connection: any) => ({ siteId: site.site_id as string, connection }))
  );
  if (matches.length !== 1) throw Object.assign(new Error("Invitation connection not found or ambiguous"), { status: 404 });
  return matches[0];
}

/** Signed webhooks and authorized polling converge on the provider's current state. */
export async function handleInvitationStatusChanged(data: any, expectedSiteId?: string) {
  const invitationId = data?.invitationId || data?.id;
  if (typeof invitationId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(invitationId)) {
    throw new Error("Invalid invitation ID");
  }
  const match = await findInvitationConnection(invitationId, expectedSiteId);
  // Delayed event status and sender IDs must not select a billable operation.
  const invitation = await getInvitation(invitationId);
  if (invitation.id !== invitationId) throw new Error("Zavu returned a different invitation");
  const connection = await getChannelConnection(match.siteId, match.connection.id);
  if (!connection || connection.zavu_invitation_id !== invitationId) throw new Error("Invitation connection changed");
  if (!["whatsapp", "messenger"].includes(connection.type)) throw new Error("Unsupported partner channel");
  if (isChannelActivationBlocked(connection)) return connection;
  const expected = { senderId: connection.zavu_sender_id || null, invitationId, type: connection.type };
  if (invitation.status !== "completed") {
    if (connection.metadata?.provider_channel_active === true && connection.status === "connected") {
      return requireActivationLicense(match.siteId, connection.id, expected);
    }
    const saved = await patchActivationConnection(match.siteId, connection.id, {
      status: mapInvitationStatus(invitation.status),
      metadata: { failure_reason: invitation.status === "failed" ? "Channel connection failed. Retry the invitation." : null },
    }, expected);
    return saved;
  }
  const senderId = invitation.senderId;
  if (!senderId || (connection.zavu_sender_id && connection.zavu_sender_id !== senderId)) {
    throw new Error("Completed invitation sender is missing or changed");
  }
  const account = invitation.connectedAccount as { channel?: string } | undefined;
  if (account?.channel && account.channel !== connection.type) throw new Error("Invitation channel mismatch");
  if (connection.status === "connected" && connection.metadata?.provider_channel_active === true
    && connection.metadata?.activation_pending === false) {
    return requireActivationLicense(match.siteId, connection.id, expected);
  }
  await patchActivationConnection(match.siteId, connection.id, {
    ...(connection.status === "connected" ? {} : { status: "in_progress" }),
    zavu_sender_id: senderId,
    connected_account: invitation.connectedAccount || connection.connected_account,
    metadata: { activation_pending: true },
  }, expected);
  const finalized = await activateChannelConnection(match.siteId, connection.id, { ...expected, senderId });
  return finalized.connection;
}