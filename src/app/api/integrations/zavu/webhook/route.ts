import { NextRequest, NextResponse } from "next/server";
import { verifyZavuSignature } from "@/lib/services/zavu";
import { decryptToken } from "@/lib/utils/token-decryption";
import { 
  findSettingsForSender, 
  handleDomainStatusChanged, 
  handleInboundMessage, 
  handleInvitationStatusChanged,
  handleVoiceCallEvent,
} from "@/lib/services/zavu/webhook-handlers";
import { sha256 } from "@/lib/security/upstash-rest";
import {
  claimProviderWebhookEvent,
  finishProviderWebhookEvent,
  type ProviderWebhookClaim,
} from "@/lib/services/provider-webhook-claims";

export async function POST(request: NextRequest) {
  try {
    const signature = request.headers.get("x-zavu-signature");
    const rawBody = await request.text();
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
    const senderId = event.senderId || event.data?.senderId || event.sender?.id;
    if (!verified && typeof senderId === "string") {
      const sites = await findSettingsForSender(senderId, { skipCache: true });
      if (sites.length > 0) {
        const site = sites[0];
        const connections = (site.channels as any)?.connections || [];
        const conn = connections.find(
          (c: any) =>
            c.zavu_sender_id === senderId
            && typeof c.metadata?.zavu_webhook_secret === "string"
        );
        if (conn?.metadata?.zavu_webhook_secret) {
          const decrypted = decryptToken(conn.metadata.zavu_webhook_secret);
          secret = decrypted || conn.metadata.zavu_webhook_secret;
          verified = verifyZavuSignature(signature, rawBody, secret);
        }
      }
    }

    if (!verified) {
      console.warn("[Zavu Webhook] Invalid signature");
      return new NextResponse("Invalid signature", { status: 401 });
    }
    const eventType = event.type
      || (event.data?.text && event.data?.from ? "message.inbound" : "unknown");
    event.type = eventType;
    console.log(`[Zavu Webhook] Received event: ${eventType || "unknown"}`);

    const providerEventId = event.id || event.eventId || event.data?.messageId;
    const eventId = typeof providerEventId === "string"
      ? providerEventId
      : await sha256(rawBody);
    let claim: ProviderWebhookClaim;
    try {
      claim = await claimProviderWebhookEvent("zavu", eventId, eventType);
    } catch (error) {
      console.error("[Zavu Webhook] Durable admission failed:", error);
      return NextResponse.json(
        { success: false, error: "Webhook admission unavailable" },
        { status: 503, headers: { "Retry-After": "5" } },
      );
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
      await processEventAsync(event);
      const completed = await finishProviderWebhookEvent(
        "zavu",
        eventId,
        claim.token,
        "completed",
      );
      if (!completed) {
        throw new Error("Zavu webhook claim ownership was lost before completion");
      }
      return new NextResponse("OK", { status: 200 });
    } catch (error) {
      await finishProviderWebhookEvent(
        "zavu",
        eventId,
        claim.token,
        "failed",
        error instanceof Error ? error.message : String(error),
      ).catch((finishError) => {
        console.error("[Zavu Webhook] Failed to record processing failure:", finishError);
      });
      throw error;
    }
  } catch (error) {
    console.error("[Zavu Webhook] Error handling webhook:", error);
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}

async function processEventAsync(event: any) {
  switch (event.type) {
    case "invitation.status_changed":
      await handleInvitationStatusChanged(event.data || {});
      break;
    case "domain.verified":
    case "domain.failed":
      await handleDomainStatusChanged(event.data || {}, event.type);
      break;
    case "message.inbound":
      console.log(`[Zavu Webhook] Inbound message on ${event.data?.channel || "unknown"}`);
      await handleInboundMessage(event);
      break;
    case "conversation.new":
      console.log(`[Zavu Webhook] New conversation started: ${event.data?.conversationId || "unknown"}`);
      // Usually message.inbound is also sent, so we just log this to avoid duplicate workflows
      break;
    case "message.unsupported":
      console.warn(`[Zavu Webhook] Unsupported message type received:`, event.data);
      break;
    case "message.queued":
    case "message.sent":
    case "message.delivered":
    case "message.read":
      console.log(`[Zavu Webhook] Delivery update: ${event.type} for message ${event.data?.messageId}`);
      break;
    case "message.failed":
      console.error(`[Zavu Webhook] Message delivery failed for ${event.data?.messageId}: [${event.data?.errorCode}] ${event.data?.errorMessage}`);
      break;
    case "call.initiated":
    case "call.answered":
    case "call.completed":
    case "call.failed":
      await handleVoiceCallEvent(event);
      break;
    case "template.status_changed":
      console.log(`[Zavu Webhook] Template status changed: ${event.data?.templateName} is now ${event.data?.currentStatus}`);
      break;
    default:
      console.log(`[Zavu Webhook] Unhandled event type: ${event.type}`);
  }
}
