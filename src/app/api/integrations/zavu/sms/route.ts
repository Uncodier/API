import { NextRequest, NextResponse } from "next/server";
import { createSender, attachSenderToAgent, ensureProjectWebhook, purchaseNumber, assignNumberToSender } from "@/lib/services/zavu";
import { supabaseAdmin } from "@/lib/database/supabase-server";
import { v4 as uuidv4 } from "uuid";

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
      console.warn("[Zavu SMS] Failed to ensure project webhook:", whError);
    }

    // Create a generic sender for SMS
    let sender;
    try {
      if (phoneNumber) {
        try {
          await purchaseNumber(phoneNumber);
        } catch (e: any) {
          console.warn("[Zavu SMS] Number might already be purchased or error buying:", e.message);
        }
      }

      sender = await createSender({
        name: name || `SMS Agent for Site ${siteId}`,
        enableSmsOneway: true // Required by Zavu when creating a sender without an initial phone number
      });
      
      if (phoneNumber) {
        await assignNumberToSender(sender.id, phoneNumber);
      }
      
      await attachSenderToAgent(sender.id);
    } catch (zavuError: any) {
      console.error("[Zavu SMS] Error creating sender:", zavuError);
      return NextResponse.json(
        { error: `Zavu API Error: ${zavuError.message || "Unknown error"}` },
        { status: 502 }
      );
    }

    // Save connection to DB
    const { data: settingsRow, error: settingsError } = await supabaseAdmin
      .from("settings")
      .select("id, channels")
      .eq("site_id", siteId)
      .maybeSingle();

    if (settingsError) {
      console.error("[Zavu SMS] Error fetching settings:", settingsError);
      return NextResponse.json({ error: "Failed to fetch site settings" }, { status: 500 });
    }

    const currentChannels = settingsRow?.channels || {};
    const connections = Array.isArray((currentChannels as any).connections)
      ? [...(currentChannels as any).connections]
      : [];

    const channelId = uuidv4();
    const nextConnection = {
      id: channelId,
      type: "sms",
      name: name || "SMS Channel",
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
      console.error("[Zavu SMS] Error updating settings:", updateError);
      return NextResponse.json({ error: "Failed to save connection in database" }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      channelId,
      senderId: sender.id,
    });
  } catch (error: any) {
    console.error("[Zavu SMS] Unhandled error in create SMS channel:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
