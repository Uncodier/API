import { NextRequest, NextResponse } from "next/server";
import { createPartnerInvitation, ConnectionType, ensureProjectWebhook, requireZavuSiteManager, getChannelConnection, isChannelActivationBlocked } from "@/lib/services/zavu";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/database/supabase-server";
import { refreshSiteConfigurationCaches } from "@/lib/services/site-configuration-cache";
import { v4 as uuidv4 } from "uuid";
import { patchActivationConnection } from "@/lib/services/zavu/activation-persistence";

/**
 * POST /api/integrations/zavu/invitations
 * Creates a Zavu partner invitation and stores it in settings.channels.connections
 */
export async function POST(request: NextRequest) {
  try {
    const parsed = z.object({
      siteId: z.string().min(1),
      connectionType: z.enum(["whatsapp_waba", "messenger"]),
      clientName: z.string().trim().min(1).optional(),
      name: z.string().trim().min(1).optional(),
      channelId: z.string().min(1).optional(),
    }).strict().safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid invitation request" }, { status: 400 });
    const { siteId, connectionType, clientName, name, channelId: existingChannelId } = parsed.data;
    await requireZavuSiteManager(request, siteId);
    const existing = await getChannelConnection(siteId, existingChannelId);
    const expectedType = connectionType === "whatsapp_waba" ? "whatsapp" : "messenger";
    if (existing && (existing.type !== expectedType || isChannelActivationBlocked(existing) || existing.zavu_sender_id)) {
      return NextResponse.json({ error: "Existing channel cannot be replaced by an invitation" }, { status: 409 });
    }

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
        { error: "Zavu could not create the invitation" },
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

    if (existing) {
      await patchActivationConnection(siteId, existing.id, {
        name: nextConnection.name,
        status: "pending",
        zavu_invitation_id: invitation.id,
        metadata: nextConnection.metadata,
      }, { senderId: null, type: expectedType, ...(existing.zavu_invitation_id ? { invitationId: existing.zavu_invitation_id } : {}) });
      return NextResponse.json({ success: true, channelId: existing.id,
        invitation: { id: invitation.id, url: invitation.url, token: invitation.token } });
    }

    if (existingIndex >= 0) {
      connections[existingIndex] = nextConnection;
    } else {
      connections.push(nextConnection);
    }

    const updatedChannels = {
      ...currentChannels,
      connections,
    };

    let updateError;
    if (settingsRow) {
      let query = supabaseAdmin.from("settings").update({ channels: updatedChannels }).eq("site_id", siteId);
      query = settingsRow.channels === null ? query.is("channels", null) : query.eq("channels", JSON.stringify(settingsRow.channels));
      const saved = await query.select("site_id").maybeSingle();
      updateError = saved.error;
      if (!saved.error && !saved.data) return NextResponse.json({ error: "Channel settings changed. Retry invitation creation." }, { status: 409 });
    } else {
      const saved = await supabaseAdmin.from("settings").insert({ site_id: siteId, channels: updatedChannels });
      updateError = saved.error;
    }

    if (updateError) {
      console.error("[Zavu] Error updating settings:", updateError);
      return NextResponse.json({ error: "Failed to save connection in database" }, { status: 500 });
    }
    await refreshSiteConfigurationCaches(siteId);

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
      { error: error.status === 401 ? "Unauthorized" : error.status === 403 ? "Forbidden" : "Could not create invitation" },
      { status: [401, 403].includes(error.status) ? error.status : 500 }
    );
  }
}
