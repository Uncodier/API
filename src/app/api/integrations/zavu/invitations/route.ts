import { NextRequest, NextResponse } from "next/server";
import { createPartnerInvitation, ConnectionType, ensureProjectWebhook } from "@/lib/services/zavu";
import { supabaseAdmin } from "@/lib/database/supabase-server";
import { v4 as uuidv4 } from "uuid";

/**
 * POST /api/integrations/zavu/invitations
 * Creates a Zavu partner invitation and stores it in settings.channels.connections
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { siteId, connectionType, clientName, name, channelId: existingChannelId } = body;

    if (!siteId) {
      return NextResponse.json({ error: "siteId is required" }, { status: 400 });
    }

    if (!connectionType || !["whatsapp_waba", "messenger"].includes(connectionType)) {
      return NextResponse.json(
        { error: "Valid connectionType is required (whatsapp_waba or messenger)" },
        { status: 400 }
      );
    }
    
    // Ensure project webhook is registered for invitation updates
    try {
      await ensureProjectWebhook();
    } catch (whError) {
      console.warn("[Zavu] Failed to ensure project webhook:", whError);
    }

    let invitation;
    try {
      invitation = await createPartnerInvitation({
        clientName: clientName || name || `Site ${siteId}`,
        connectionType: connectionType as ConnectionType,
      });
    } catch (zavuError: any) {
      console.error("[Zavu] Error creating invitation:", zavuError);
      return NextResponse.json(
        { error: `Zavu API Error: ${zavuError.message || "Unknown error"}` },
        { status: 502 }
      );
    }

    const { data: settingsRow, error: settingsError } = await supabaseAdmin
      .from("settings")
      .select("id, channels")
      .eq("site_id", siteId)
      .maybeSingle();

    if (settingsError) {
      console.error("[Zavu] Error fetching settings:", settingsError);
      return NextResponse.json({ error: "Failed to fetch site settings" }, { status: 500 });
    }

    const currentChannels = settingsRow?.channels || {};
    const connections = Array.isArray((currentChannels as any).connections)
      ? [...(currentChannels as any).connections]
      : [];

    const channelType = connectionType === "whatsapp_waba" ? "whatsapp" : "messenger";
    const now = new Date().toISOString();
    const existingIndex = existingChannelId
      ? connections.findIndex((item: any) => item.id === existingChannelId)
      : -1;
    const channelId = existingChannelId || uuidv4();

    const nextConnection = {
      ...(existingIndex >= 0 ? connections[existingIndex] : {}),
      id: channelId,
      type: channelType,
      name: name || `${channelType.charAt(0).toUpperCase() + channelType.slice(1)} Channel`,
      status: "pending",
      zavu_invitation_id: invitation.id,
      metadata: {
        invitation_url: invitation.url,
        invitation_token: invitation.token,
      },
      created_at: existingIndex >= 0 ? connections[existingIndex].created_at : now,
      updated_at: now,
    };

    if (existingIndex >= 0) {
      connections[existingIndex] = nextConnection;
    } else {
      connections.push(nextConnection);
    }

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
      console.error("[Zavu] Error updating settings:", updateError);
      return NextResponse.json({ error: "Failed to save connection in database" }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      channelId,
      invitation: {
        id: invitation.id,
        url: invitation.url,
        token: invitation.token,
      },
    });
  } catch (error: any) {
    console.error("[Zavu] Unhandled error in create invitation:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
