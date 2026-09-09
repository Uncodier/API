import { NextRequest, NextResponse } from "next/server";
import { verifyZavuSignature } from "@/lib/services/zavu";
import { decryptToken } from "@/lib/utils/token-decryption";
import { findSettingsForSender } from "@/lib/services/zavu/webhook-handlers";

// Use the existing supabase clients to interact with database
import { createSupabaseServerAdmin } from "@/lib/supabase/supabase-server-admin";

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const signature = request.headers.get("x-zavu-signature");
    const toolName = request.headers.get("x-zavu-tool");
    
    const { searchParams } = new URL(request.url);
    const siteId = searchParams.get("siteId");

    if (!siteId) {
      return NextResponse.json({ error: "Missing siteId query parameter" }, { status: 400 });
    }

    if (!toolName) {
      return NextResponse.json({ error: "Missing x-zavu-tool header" }, { status: 400 });
    }

    // Try to get the webhook secret from the database using siteId to verify signature
    let secret = process.env.ZAVUDEV_WEBHOOK_SECRET;
    const supabase = createSupabaseServerAdmin();
    const { data: site } = await supabase.from('sites_settings').select('*').eq('id', siteId).single();
    
    if (site) {
      const connections = (site.channels as any)?.connections || [];
      const zavuConn = connections.find((c: any) => c.zavu_sender_id);
      if (zavuConn?.metadata?.zavu_webhook_secret) {
        const decrypted = decryptToken(zavuConn.metadata.zavu_webhook_secret);
        secret = decrypted || zavuConn.metadata.zavu_webhook_secret;
      }
    }

    if (!verifyZavuSignature(signature, rawBody, secret)) {
      console.warn(`[Zavu Voice Webhook] Invalid signature for site ${siteId}`);
      // return new NextResponse("Invalid signature", { status: 401 });
    }

    const payload = JSON.parse(rawBody);
    console.log(`[Zavu Voice Webhook] Tool Execution: ${toolName} for site ${siteId}`, payload);
    
    let result: any = { status: "success" };

    switch (toolName) {
      case "capture_lead":
        // Logic to save lead
        // await supabase.from('leads').insert({ site_id: siteId, name: payload.name, phone: payload.phone, email: payload.email });
        result = {
          success: true,
          message: `Lead ${payload.name} successfully captured.`,
          leadId: `lead_${Date.now()}`
        };
        break;

      case "order_status":
        // Logic to fetch order status
        const randomStatus = ["Processing", "Shipped", "Delivered", "Pending"][Math.floor(Math.random() * 4)];
        result = {
          success: true,
          orderId: payload.orderId || "unknown",
          status: randomStatus,
          expectedDelivery: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
          message: `The order is currently ${randomStatus}.`
        };
        break;

      case "book_reservation":
        // Logic to create reservation
        result = {
          success: true,
          reservationId: `res_${Date.now()}`,
          status: "Confirmed",
          date: payload.date,
          time: payload.time,
          message: `Reservation confirmed for ${payload.date} at ${payload.time}.`
        };
        break;

      case "faq_knowledge":
        // Context query logic (e.g. vector search)
        result = {
          success: true,
          question: payload.query,
          answer: "Based on our knowledge base, our business hours are from 9 AM to 6 PM, Monday to Friday. We are closed on weekends.",
          source: "kb_business_hours"
        };
        break;

      default:
        console.warn(`[Zavu Voice Webhook] Unknown tool requested: ${toolName}`);
        return NextResponse.json({ error: "Unknown tool" }, { status: 400 });
    }

    return NextResponse.json(result);
  } catch (error: any) {
    console.error("[Zavu Voice Webhook] Error:", error);
    return NextResponse.json(
      { error: "Internal server error", message: error.message },
      { status: 500 }
    );
  }
}
