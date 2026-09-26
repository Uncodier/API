import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  activateSenderChannel,
  getChannelConnection,
  requireZavuSiteManager,
  upsertChannelConnection,
} from "@/lib/services/zavu";

const activationSchema = z.object({
  siteId: z.string().min(1),
  channelId: z.string().min(1),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: senderId } = await params;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const parsed = activationSchema.safeParse(body);
    if (!senderId || !parsed.success) {
      return NextResponse.json(
        { error: "senderId, siteId, and channelId are required" },
        { status: 400 }
      );
    }
    const { siteId, channelId } = parsed.data;
    await requireZavuSiteManager(request, siteId);

    const connection = await getChannelConnection(siteId, channelId);
    if (!connection) {
      return NextResponse.json(
        { error: "Email channel connection was not found" },
        { status: 404 }
      );
    }
    if (connection.type !== "email" || connection.zavu_sender_id !== senderId) {
      return NextResponse.json(
        { error: "Sender does not match the email channel connection" },
        { status: 409 }
      );
    }

    let activation;
    try {
      activation = await activateSenderChannel(senderId, "email");
    } catch (error) {
      console.error("[Zavu] Email channel activation failed:", error);
      return NextResponse.json(
        { error: "Zavu could not activate the email channel" },
        { status: 502 }
      );
    }
    const activeChannels = activation?.sender?.channels;
    if (
      activation?.sender?.id !== senderId ||
      !Array.isArray(activeChannels) ||
      !activeChannels.includes("email")
    ) {
      return NextResponse.json(
        { error: "Zavu did not confirm email channel activation" },
        { status: 502 }
      );
    }

    await upsertChannelConnection(siteId, channelId, {
      status: "connected",
      metadata: {
        emailChannelActive: true,
      },
    });

    return NextResponse.json({
      success: true,
      ...activation,
    });
  } catch (error: any) {
    console.error("[Zavu] Error activating email channel:", error);
    return NextResponse.json(
      { error: error.message || "Failed to activate email channel" },
      { status: error.status || 500 }
    );
  }
}
