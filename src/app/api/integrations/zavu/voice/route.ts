import { NextRequest, NextResponse } from "next/server";
import { createSender, attachSenderToAgent, ensureProjectWebhook, purchaseNumber, assignNumberToSender } from "@/lib/services/zavu";
import { supabaseAdmin } from "@/lib/database/supabase-server";
import { v4 as uuidv4 } from "uuid";

// Re-use logic to sync tools to Zavu Voice since it's the backend
const VOICE_TOOLS_SCHEMA = [
  {
    name: "capture_lead",
    description: "Captures lead information (name, phone, email) from the user during the call to follow up later.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Full name of the lead" },
        email: { type: "string", description: "Email address of the lead" },
        phone: { type: "string", description: "Phone number of the lead" }
      },
      required: ["name", "phone"]
    }
  },
  {
    name: "order_status",
    description: "Check the current status of a customer's order using their order ID.",
    parameters: {
      type: "object",
      properties: {
        orderId: { type: "string", description: "The unique identifier of the order" }
      },
      required: ["orderId"]
    }
  },
  {
    name: "book_reservation",
    description: "Book a reservation or appointment for a specific date and time.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "The requested date for the reservation (YYYY-MM-DD)" },
        time: { type: "string", description: "The requested time for the reservation (HH:MM)" },
        guests: { type: "number", description: "Number of guests or participants" }
      },
      required: ["date", "time"]
    }
  },
  {
    name: "faq_knowledge",
    description: "Query the knowledge base or FAQ to answer customer questions about business hours, policies, etc.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The user's question or search query" }
      },
      required: ["query"]
    }
  }
];

async function syncSiteToolsToZavu(siteId: string, zavuSenderId: string) {
  const ZAVU_API_KEY = process.env.ZAVUDEV_API_KEY;
  const webhookSecret = process.env.ZAVUDEV_WEBHOOK_SECRET;
  const API_URL = process.env.NEXT_PUBLIC_API_SERVER_URL || process.env.API_SERVER_URL;
  const webhookUrl = `${API_URL}/api/integrations/zavu/voice-tools?siteId=${siteId}`;

  for (const tool of VOICE_TOOLS_SCHEMA) {
    const payload = {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      webhookUrl: webhookUrl,
      webhookSecret: webhookSecret
    };

    const response = await fetch(`https://api.zavu.dev/v1/senders/${zavuSenderId}/agent/tools`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${ZAVU_API_KEY}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Zavu Voice] Error registrando tool ${tool.name} en Zavu:`, errorText);
    } else {
      console.log(`[Zavu Voice] Tool ${tool.name} registrado con éxito para sender ${zavuSenderId}.`);
    }
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { siteId, name, phoneNumber } = body;

    if (!siteId) {
      return NextResponse.json({ error: "siteId is required" }, { status: 400 });
    }

    try {
      await ensureProjectWebhook();
    } catch (whError) {
      console.warn("[Zavu Voice] Failed to ensure project webhook:", whError);
    }

    // Create a generic sender for Voice
    let sender;
    try {
      if (phoneNumber) {
        try {
          await purchaseNumber(phoneNumber);
        } catch (e: any) {
          console.warn("[Zavu Voice] Number might already be purchased or error buying:", e.message);
        }
      }

      sender = await createSender({
        name: name || `Voice Agent for Site ${siteId}`,
        enableSmsOneway: phoneNumber ? undefined : true
      });
      
      if (phoneNumber) {
        await assignNumberToSender(sender.id, phoneNumber);
      }
      
      await attachSenderToAgent(sender.id);
    } catch (zavuError: any) {
      console.error("[Zavu Voice] Error creating sender:", zavuError);
      return NextResponse.json(
        { error: `Zavu API Error: ${zavuError.message || "Unknown error"}` },
        { status: 502 }
      );
    }

    // Sync the voice tools immediately after creating the sender
    await syncSiteToolsToZavu(siteId, sender.id);

    // Save connection to DB
    const { data: settingsRow, error: settingsError } = await supabaseAdmin
      .from("settings")
      .select("id, channels")
      .eq("site_id", siteId)
      .maybeSingle();

    if (settingsError) {
      console.error("[Zavu Voice] Error fetching settings:", settingsError);
      return NextResponse.json({ error: "Failed to fetch site settings" }, { status: 500 });
    }

    const currentChannels = settingsRow?.channels || {};
    const connections = Array.isArray((currentChannels as any).connections)
      ? [...(currentChannels as any).connections]
      : [];

    const channelId = uuidv4();
    const nextConnection = {
      id: channelId,
      type: "voice",
      name: name || "Voice Channel",
      status: "connected",
      zavu_sender_id: sender.id,
      metadata: {
        phone_number: phoneNumber,
        webhook_events: sender.webhook?.events || [],
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    connections.push(nextConnection);
    const updatedChannels = {
      ...currentChannels,
      connections,
    };

    const { error: updateError } = settingsRow
      ? await supabaseAdmin
          .from("settings")
          .update({ channels: updatedChannels })
          .eq("site_id", siteId)
      : await supabaseAdmin
          .from("settings")
          .insert({ site_id: siteId, channels: updatedChannels });

    if (updateError) {
      console.error("[Zavu Voice] Error updating settings:", updateError);
      return NextResponse.json({ error: "Failed to save connection in database" }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      channelId,
      senderId: sender.id,
    });
  } catch (error: any) {
    console.error("[Zavu Voice] Unhandled error in create voice channel:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
