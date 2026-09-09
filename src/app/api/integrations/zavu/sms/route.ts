import { NextRequest, NextResponse } from "next/server";
import { createSender, attachSenderToAgent, ensureProjectWebhook, purchaseNumber, assignNumberToSender } from "@/lib/services/zavu";
import { supabaseAdmin } from "@/lib/database/supabase-server";
import { v4 as uuidv4 } from "uuid";

// Re-use logic to sync tools to Zavu Voice since it's the backend


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
