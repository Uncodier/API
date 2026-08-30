import { NextRequest, NextResponse, after } from "next/server";
import { verifyZavuSignature } from "@/lib/services/zavu";
import { decryptToken } from "@/lib/utils/token-decryption";
import { 
  findSettingsForSender, 
  handleDomainStatusChanged, 
  handleInboundMessage, 
  handleInvitationStatusChanged 
} from "@/lib/services/zavu/webhook-handlers";

export async function POST(request: NextRequest) {
  try {
    const signature = request.headers.get("x-zavu-signature");
    const rawBody = await request.text();
    let secret = process.env.ZAVUDEV_WEBHOOK_SECRET;

    // Parse early only to inspect senderId (this doesn't affect signature checking against rawBody)
    let event: any = {};
    try {
      event = JSON.parse(rawBody);
    } catch (e) {
      console.error("[Zavu Webhook] Failed to parse body", e);
    }

    // Since every created sender has its own webhook secret, we look it up from the DB
    const senderId = event.senderId || event.data?.senderId || event.sender?.id;
    if (senderId) {
      const sites = await findSettingsForSender(senderId);
      if (sites.length > 0) {
        const site = sites[0];
        const connections = (site.channels as any)?.connections || [];
        const conn = connections.find((c: any) => c.zavu_sender_id === senderId);
        if (conn?.metadata?.zavu_webhook_secret) {
          const decrypted = decryptToken(conn.metadata.zavu_webhook_secret);
          secret = decrypted || conn.metadata.zavu_webhook_secret;
          console.log(`[Zavu Webhook] Found specific secret for sender ${senderId} (decrypted: ${!!decrypted})`);
        } else {
          console.log(`[Zavu Webhook] No secret stored for sender ${senderId}, falling back to env var`);
        }
      } else {
        console.log(`[Zavu Webhook] Site not found for sender ${senderId}`);
      }
    } else {
      console.log(`[Zavu Webhook] No senderId in event payload, will use project secret`);
    }

    // Acknowledge immediately before slow verifications or processing, to keep it async like Vercel needs
    // But we need to verify signature first before trusting the payload
    if (!verifyZavuSignature(signature, rawBody, secret)) {
      console.warn("[Zavu Webhook] Invalid signature");
      return new NextResponse("Invalid signature", { status: 401 });
    }

    const eventType = event.type || (event.data?.text && event.data?.from ? "message.inbound" : undefined);
    event.type = eventType;
    console.log(`[Zavu Webhook] Received event: ${eventType || "unknown"}`);

    after(() =>
      processEventAsync(event).catch((error) => {
        console.error("[Zavu Webhook] Async processing error:", error);
      })
    );

    return new NextResponse("OK", { status: 200 });
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
    case "template.status_changed":
      console.log(`[Zavu Webhook] Template status changed: ${event.data?.templateName} is now ${event.data?.currentStatus}`);
      break;
    default:
      console.log(`[Zavu Webhook] Unhandled event type: ${event.type}`);
  }
}
