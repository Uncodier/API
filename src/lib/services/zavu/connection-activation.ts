import { ensureSenderWebhook } from "./client";
import { ensureSenderChannelActive, isActivatableChannel, isChannelActivationBlocked } from "./channel-activation";
import { getChannelConnection } from "./persist";
import { patchActivationConnection, requireActivationLicense, type ActivationExpected } from "./activation-persistence";
import { prepareActivationWebhookSecret } from "./activation-webhook-secret";

/** Finalize an owned connection; callers authorize the manager or verify the provider webhook. */
export async function activateChannelConnection(siteId: string, channelId: string, identity?: ActivationExpected) {
  const connection = await getChannelConnection(siteId, channelId);
  if (!connection?.zavu_sender_id || !isActivatableChannel(connection.type)) {
    throw Object.assign(new Error("Channel is not ready for activation"), { status: 409 });
  }
  if (isChannelActivationBlocked(connection)) {
    throw Object.assign(new Error("Channel is disabled or suspended"), { status: 409 });
  }
  const senderId = connection.zavu_sender_id;
  if (identity && ((identity.senderId !== undefined && identity.senderId !== senderId)
    || (identity.type && identity.type !== connection.type)
    || (identity.invitationId && identity.invitationId !== connection.zavu_invitation_id))) {
    throw Object.assign(new Error("Channel identity changed"), { status: 409 });
  }
  const expected = { ...identity, senderId, type: connection.type };
  await requireActivationLicense(siteId, channelId, expected);
  const save = (patch: Record<string, any>) => patchActivationConnection(siteId, channelId, patch, expected);
  await save({
    ...(connection.status === "connected" ? {} : { status: "in_progress" }),
    metadata: { activation_pending: true, activation_error: null },
  });
  try {
    const sender = await ensureSenderWebhook(senderId);
    if (sender?.id !== senderId) throw new Error("Zavu returned a different sender");
    await prepareActivationWebhookSecret(siteId, channelId, expected, sender.webhook?.secret);
    // Save the signing secret before activation can start inbound delivery.
    await save({
      metadata: { zavu_webhook_events: sender.webhook?.events || [] },
    });
    const fresh = await getChannelConnection(siteId, channelId);
    if (fresh?.zavu_sender_id !== senderId || isChannelActivationBlocked(fresh)) {
      throw new Error("Channel changed before activation");
    }
    await requireActivationLicense(siteId, channelId, expected);
    const activation = await ensureSenderChannelActive(senderId, connection.type);
    await requireActivationLicense(siteId, channelId, expected);
    const saved = await save({
      status: "connected",
      metadata: {
        activation_pending: false,
        activation_error: null,
        provider_channel_active: true,
        ...(connection.type === "email" ? { emailChannelActive: true } : {}),
      },
    });
    return { activation, connection: saved };
  } catch (error: any) {
    await save({
      metadata: { activation_pending: true, activation_error: "Channel activation could not be confirmed. Retry activation." },
    }).catch(() => undefined);
    if (error?.status === 409) throw error;
    throw Object.assign(new Error("Zavu could not complete channel activation"), { status: 502 });
  }
}