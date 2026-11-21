import { ChannelMessageReconciliationError } from '../channels/channel-message-reconciliation-error';
import { NextResponse } from "next/server";
import { verifyZavuSignature } from './signature';
import { inboundBinding, inboundClaimIdentity, inboundSender, type InboundBinding } from './inbound-claim';
import { decryptToken } from "@/lib/utils/token-decryption";
import { findSettingsForSender, handleInboundMessage } from './webhook-handlers';
import { BodyTooLargeError, readBoundedText } from '@/lib/security/request-body';
import { sha256 } from "@/lib/security/upstash-rest";
import {
  claimProviderWebhookEvent,
  claimZavuInboundWebhook,
  finishProviderWebhookEvent,
  type ProviderWebhookClaim,
} from "@/lib/services/provider-webhook-claims";

/** Both URLs use the same signature, receipt namespace and inbound handler. Only
 * the registered provider callback supplies a handler for non-message events. */
export async function receiveZavuWebhook(request: Request,
  otherEvent?: (event: any, verifiedSiteId?: string, verifiedConnectionId?: string) => Promise<void>) {
  try {
    const signature = request.headers.get("x-zavu-signature");
    if (!signature) return new NextResponse('Missing signature', { status: 401 });
    const rawBody = await readBoundedText(request, 1024 * 1024);
    let secret = process.env.ZAVUDEV_WEBHOOK_SECRET;

    let event: any;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }

    // Prefer the project secret so invalid requests never reach the database.
    let verified = verifyZavuSignature(signature, rawBody, secret);
    let verifiedSiteId: string | undefined;
    let verifiedConnectionId: string | undefined;
    let signedSenderSettings: Awaited<ReturnType<typeof findSettingsForSender>> | undefined;
    const senderId = event.senderId || event.data?.senderId || event.sender?.id;
    if (!verified && typeof senderId === "string") {
      const sites = await findSettingsForSender(senderId, { skipCache: true });
      if (sites.length === 1) {
        const site = sites[0];
        const connections = (site.channels as any)?.connections || [];
        const messageEvent = (typeof event.type === 'string' && event.type.startsWith('message.'))
          || (!event.type && event.data?.text && event.data?.from);
        // Message secrets authenticate one persisted connection, not whichever
        // connection owns the sender when the lifecycle handler reads settings.
        const binding = messageEvent && inboundSender(event) === senderId
          ? inboundBinding(sites, senderId, event.data?.channel) : undefined;
        const conn = Array.isArray(connections) ? connections.find((c: any) => c?.zavu_sender_id === senderId
          && (!messageEvent || (binding && c.id === binding.connectionId))
          && typeof c.metadata?.zavu_webhook_secret === 'string') : undefined;
        if (conn?.metadata?.zavu_webhook_secret) {
          const decrypted = decryptToken(conn.metadata.zavu_webhook_secret);
          secret = decrypted || conn.metadata.zavu_webhook_secret;
          verified = verifyZavuSignature(signature, rawBody, secret);
          if (verified) {
            verifiedSiteId = site.site_id;
            verifiedConnectionId = binding?.connectionId;
            signedSenderSettings = sites;
          }
        }
      }
    }

    if (!verified) {
      console.warn("[Zavu Webhook] Invalid signature");
      return new NextResponse("Invalid signature", { status: 401 });
    }
    const eventType = event.type
      || (event.data?.text && event.data?.from ? "message.inbound" : "unknown");
    if (typeof eventType !== 'string') return NextResponse.json({ error: 'Invalid event type' }, { status: 400 });
    event.type = eventType;
    if (eventType !== 'message.inbound' && !otherEvent) {
      return NextResponse.json({ error: 'Expected an inbound message' }, { status: 400 });
    }
    console.log(`[Zavu Webhook] Received event: ${eventType || "unknown"}`);

    let provider = 'zavu';
    let eventId: string;
    let binding: InboundBinding | undefined;
    let claim: ProviderWebhookClaim | { state: 'reconcile' };
    try {
      if (eventType === 'message.inbound') {
        const sender = inboundSender(event);
        if (!sender) return NextResponse.json({ error: 'Invalid inbound sender' }, { status: 400 });
        const sites = signedSenderSettings ?? await findSettingsForSender(sender, { skipCache: true });
        binding = inboundBinding(sites, sender, event.data?.channel, verifiedSiteId);
        if (!binding) return NextResponse.json({ error: 'Inbound source requires reconciliation' }, { status: 409 });
        const identity = inboundClaimIdentity(event, rawBody, binding);
        if (!identity) return NextResponse.json({ error: 'Invalid inbound identity' }, { status: 400 });
        ({ provider, eventId } = identity);
        claim = await claimZavuInboundWebhook(identity);
      } else {
        const providerEventId = event.id || event.eventId || (event.data?.messageId ? `${eventType}:${event.data.messageId}` : undefined);
        eventId = typeof providerEventId === 'string' ? providerEventId : await sha256(rawBody);
        claim = await claimProviderWebhookEvent(provider, eventId, eventType);
      }
    } catch (error) {
      console.error("[Zavu Webhook] Durable admission failed:", error);
      return NextResponse.json(
        { success: false, error: "Webhook admission unavailable" },
        { status: 503, headers: { "Retry-After": "5" } },
      );
    }
    if (claim.state === 'reconcile') {
      return NextResponse.json({ success: false, error: 'Inbound receipt requires reconciliation' }, { status: 409 });
    }
    if (claim.state === "completed") {
      return NextResponse.json({ success: true, duplicate: true });
    }
    if (claim.state === "busy") {
      return NextResponse.json(
        { success: false, error: "Webhook event is already processing" },
        { status: 503, headers: { "Retry-After": "5" } },
      );
    }

    try {
      if (eventType === 'message.inbound') {
        // For older payloads without a message ID, reuse the authenticated receipt
        // identity (eventId or signed-body digest); never generate a second work ID.
        await handleInboundMessage({ ...event, id: eventId }, verifiedSiteId, { binding, reconcileOnly: claim.reconcileOnly });
      } else {
        await otherEvent!(event, verifiedSiteId, verifiedConnectionId);
      }
      const completed = await finishProviderWebhookEvent(
        provider,
        eventId,
        claim.token,
        "completed",
      );
      if (!completed) {
        throw new Error("Zavu webhook claim ownership was lost before completion");
      }
      return new NextResponse("OK", { status: 200 });
    } catch (error) {
      const recorded = await finishProviderWebhookEvent(provider, eventId, claim.token, 'failed',
        error instanceof ChannelMessageReconciliationError || (otherEvent && eventType !== 'message.inbound' && error instanceof Error)
          ? error.message : 'Webhook processing did not complete',
      ).catch(() => false);
      if (!recorded) return NextResponse.json({ success: false, error: 'Receipt ownership could not be verified' },
        { status: 503, headers: { 'Retry-After': '5' } });
      if (error instanceof ChannelMessageReconciliationError) {
        const {workflowId,state,stage} = error.report;
        return NextResponse.json({success:false,reconciliation_required:true,workflowId,state,stage}, {status:202});
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof BodyTooLargeError) return new NextResponse('Payload too large', { status: 413 });
    console.error("[Zavu Webhook] Error handling webhook:", error);
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}

