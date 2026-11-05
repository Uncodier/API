import { claimProviderWebhookEvent, finishProviderWebhookEvent } from "@/lib/services/provider-webhook-claims";
import { getChannelConnection } from "./persist";
import { patchActivationConnection, type ActivationExpected } from "./activation-persistence";
import { encryptToken } from "@/lib/utils/token-encryption";
import { zavuFetch } from "./client";

/** Serialize missing-secret initialization across webhook and polling workers. */
export async function prepareActivationWebhookSecret(siteId: string, channelId: string, expected: ActivationExpected, returnedSecret?: unknown) {
  const connection = await getChannelConnection(siteId, channelId);
  if (connection?.metadata?.zavu_webhook_secret) return;
  const senderId = expected.senderId;
  if (!senderId || connection?.zavu_sender_id !== senderId) throw new Error("Channel sender changed");
  const eventId = `activation-secret:${senderId}`;
  const claim = await claimProviderWebhookEvent("zavu", eventId, "activation.secret", 300);
  if (claim.state === "completed") {
    const fresh = await getChannelConnection(siteId, channelId);
    if (fresh?.zavu_sender_id === senderId && fresh.metadata?.zavu_webhook_secret) return;
    throw new Error("Sender webhook secret requires reconciliation");
  }
  if (claim.state === "busy") throw new Error("Sender webhook initialization is in progress");
  let rotationStarted = false;
  try {
    const fresh = await getChannelConnection(siteId, channelId);
    if (fresh?.zavu_sender_id !== senderId) throw new Error("Channel sender changed");
    if (!fresh.metadata?.zavu_webhook_secret) {
      if (fresh.metadata?.webhook_rotation_uncertain === true) {
        throw new Error("Ambiguous webhook rotation requires reconciliation");
      }
      const deadline = Date.parse(claim.expiresAt);
      if (!Number.isFinite(deadline) || Date.now() + 30_000 >= deadline) throw new Error("Webhook initialization lease expired");
      const fenced = { ...expected, secretInitializationToken: claim.token };
      await patchActivationConnection(siteId, channelId, { metadata: { webhook_initialization_token: claim.token } }, expected);
      // Prefer the one-time secret returned by setup. Regeneration is bounded
      // well below the durable lease, and no other initializer can rotate it.
      let secret = typeof returnedSecret === "string" && returnedSecret ? returnedSecret : undefined;
      if (!secret) {
        await patchActivationConnection(siteId, channelId, { metadata: { webhook_rotation_uncertain: true } }, fenced);
        rotationStarted = true;
        secret = (await zavuFetch<{ secret?: string }>(`/senders/${encodeURIComponent(senderId)}/webhook/secret`, {
          method: "POST", signal: AbortSignal.timeout(15_000),
        })).secret;
      }
      if (!secret) throw new Error("Zavu did not return a webhook secret");
      if (Date.now() + 15_000 >= deadline) throw new Error("Webhook initialization lease expired");
      await patchActivationConnection(siteId, channelId, { metadata: { zavu_webhook_secret: encryptToken(secret), webhook_rotation_uncertain: false } }, fenced);
      rotationStarted = false;
    }
    if (!await finishProviderWebhookEvent("zavu", eventId, claim.token, "completed")) {
      throw new Error("Webhook initialization ownership was lost");
    }
  } catch {
    if (!rotationStarted) await finishProviderWebhookEvent("zavu", eventId, claim.token, "failed", "Webhook secret initialization failed").catch(() => undefined);
    throw new Error("Could not initialize sender webhook secret");
  }
}