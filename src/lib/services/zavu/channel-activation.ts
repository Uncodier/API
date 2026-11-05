import { activateSenderChannel, zavuFetch } from "./client";

export const ACTIVATABLE_CHANNELS = ["whatsapp", "telegram", "instagram", "messenger", "email"] as const;
export type ActivatableChannel = typeof ACTIVATABLE_CHANNELS[number];

export function isActivatableChannel(value: unknown): value is ActivatableChannel {
  return typeof value === "string" && ACTIVATABLE_CHANNELS.includes(value as ActivatableChannel);
}

export function isChannelActivationBlocked(connection: any): boolean {
  return connection?.enabled === false || connection?.license_suspended === true
    || connection?._license?.manually_disabled === true
    || ["disabled", "inactive", "suspended", "license_suspended"].includes(connection?.status);
}

function confirmsActivation(sender: any, senderId: string, channel: ActivatableChannel): boolean {
  return sender?.id === senderId && Array.isArray(sender.channels) && sender.channels.includes(channel);
}

/** Only call after authorization and connection ownership checks. This may incur provider fees. */
export async function ensureSenderChannelActive(senderId: string, channel: ActivatableChannel): Promise<any> {
  if (!senderId || !isActivatableChannel(channel)) throw new Error("Invalid channel activation");
  const current = await zavuFetch<any>(`/senders/${encodeURIComponent(senderId)}`);
  const sender = current?.sender || current;
  if (sender?.id !== senderId) throw new Error("Zavu returned a different sender");
  if (confirmsActivation(sender, senderId, channel)) {
    return { activated: false, chargedCents: 0, sender };
  }

  // Zavu documents activation as idempotent, including concurrent/replayed requests.
  const activation = await activateSenderChannel(senderId, channel);
  if (!confirmsActivation(activation?.sender, senderId, channel)) {
    throw new Error("Zavu did not confirm channel activation");
  }
  return activation;
}