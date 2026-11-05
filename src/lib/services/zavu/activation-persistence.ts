import { supabaseAdmin } from "@/lib/database/supabase-server";
import { refreshSiteConfigurationCaches } from "@/lib/services/site-configuration-cache";
import { getSiteLicensedResources, isChannelActiveStatus, type LicensedResources } from "@/lib/billing/licensed-resources";
import { isChannelActivationBlocked } from "./channel-activation";

export type ActivationExpected = { senderId?: string | null; invitationId?: string; emailDomainId?: string; type?: string; secretInitializationToken?: string };
type Expected = ActivationExpected;
function conflict(): never {
  throw Object.assign(new Error("Channel changed, is unavailable, or is disabled"), { status: 409 });
}
function check(connection: any, expected: Expected) {
  if (!connection || isChannelActivationBlocked(connection)) conflict();
  if (expected.type && connection.type !== expected.type) conflict();
  if (expected.invitationId && connection.zavu_invitation_id !== expected.invitationId) conflict();
  if (expected.emailDomainId && connection.metadata?.email_domain_id !== expected.emailDomainId) conflict();
  if (expected.senderId !== undefined && (connection.zavu_sender_id || null) !== expected.senderId) conflict();
  if (expected.secretInitializationToken && connection.metadata?.webhook_initialization_token !== expected.secretInitializationToken) conflict();
  return connection;
}

/** Existing-only compare-and-swap: never recreate deleted channels or overwrite concurrent disable. */
export async function patchActivationConnection(
  siteId: string, channelId: string, patch: Record<string, any>, expected: Expected,
): Promise<any> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: row, error } = await supabaseAdmin.from("settings").select("channels")
      .eq("site_id", siteId).maybeSingle();
    if (error) throw new Error("Could not read channel settings");
    if (!row) conflict();
    const connections = row?.channels?.connections;
    if (!Array.isArray(connections)) conflict();
    const matches = connections.filter((item: any) => item.id === channelId);
    if (matches.length !== 1) conflict();
    const previous = check(matches[0], expected);
    const next = { ...previous, ...patch, id: previous.id, type: previous.type,
      metadata: { ...previous.metadata, ...patch.metadata }, updated_at: new Date().toISOString() };
    const { data: saved, error: writeError } = await supabaseAdmin.from("settings")
      .update({ channels: { ...row.channels, connections: connections.map((item: any) => item.id === channelId ? next : item) } })
      .eq("site_id", siteId).eq("channels", JSON.stringify(row.channels)).select("channels").maybeSingle();
    if (writeError) throw new Error("Could not save channel settings");
    if (!saved) continue;
    await refreshSiteConfigurationCaches(siteId);
    const canonical = saved.channels?.connections?.find((item: any) => item.id === channelId);
    check(canonical, { ...expected,
      ...(patch.zavu_sender_id ? { senderId: patch.zavu_sender_id } : {}),
      ...(patch.zavu_invitation_id ? { invitationId: patch.zavu_invitation_id } : {}),
    });
    if (patch.status === "connected" && canonical.status !== "connected") conflict();
    return canonical;
  }
  return conflict();
}

/** Pending setup is allowed; projected suspension/manual disable must still fail closed. */
export async function requireActivationLicense(siteId: string, channelId: string, expected: Expected) {
  const projection = await getSiteLicensedResources(siteId);
  const { channels } = projection;
  const matches = channels.connections.filter((item) => item.id === channelId);
  if (matches.length !== 1 || matches[0].license_suspended !== false) conflict();
  const connection = check(matches[0], expected);
  if (!isChannelActiveStatus(connection.type, connection.status)) await requireFreeActivationSlot(siteId, projection);
  return connection;
}

async function requireFreeActivationSlot(siteId: string, projection: LicensedResources) {
  // Mirror the existing set_site_agent_channel_enabled admission formula. This is
  // a preflight, not a reservation; the database remains the final admission gate.
  const limits = { commission: [1, 0], engine: [3, 1], foundry: [6, 3], enterprise: [10, 10] } as const;
  const [socialLimit, agentLimit] = limits[projection.effective_plan];
  const socialUsed = projection.social_media.filter((row) => [true, 1].includes(row.isActive) && row.license_suspended === false).length;
  const agentUsed = projection.channels.connections.filter((row) =>
    isChannelActiveStatus(row.type, row.status) && row.enabled !== false && row.license_suspended === false
  ).length;
  const { data: billing, error } = await supabaseAdmin.from("billing")
    .select("addons_count,stripe_subscription_id,paid_subscription_invoice_id,paid_subscription_period_start,paid_subscription_period_end,subscription_status")
    .eq("site_id", siteId).maybeSingle();
  if (error) throw new Error("Could not verify channel capacity");
  const now = Date.now();
  const paid = billing && (!billing.stripe_subscription_id || (
    billing.paid_subscription_invoice_id && Date.parse(billing.paid_subscription_period_start) <= now
    && Date.parse(billing.paid_subscription_period_end) > now
    && !["canceled", "cancelled", "incomplete_expired"].includes(String(billing.subscription_status || "").toLowerCase())
  ));
  const addons = paid && Number.isSafeInteger(billing.addons_count) ? Math.max(0, billing.addons_count) : 0;
  if (Math.max(socialUsed - socialLimit, 0) + Math.max(agentUsed + 1 - agentLimit, 0) > addons) {
    throw Object.assign(new Error("Account limit reached"), { status: 409, code: "ACCOUNT_LIMIT" });
  }
}