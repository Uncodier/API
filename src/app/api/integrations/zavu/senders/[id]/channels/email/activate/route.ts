import { NextRequest, NextResponse } from "next/server";
import {
  activateSenderChannel,
  getChannelConnection,
  upsertChannelConnection,
} from "@/lib/services/zavu";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: senderId } = await params;
    const body = await request.json();
    const { siteId, channelId } = body;

    if (!senderId || !siteId || !channelId) {
      return NextResponse.json(
        { error: "senderId, siteId, and channelId are required" },
        { status: 400 }
      );
    }

    const connection = await getChannelConnection(siteId, channelId);
    if (!connection) {
      return NextResponse.json(
        { error: "Email channel connection was not found" },
        { status: 404 }
      );
    }
    if (connection.zavu_sender_id !== senderId) {
      return NextResponse.json(
        { error: "Sender does not match the email channel connection" },
        { status: 409 }
      );
    }

    const activation = await activateSenderChannel(senderId, "email");
    const activeChannels = activation?.sender?.channels;
    if (!Array.isArray(activeChannels) || !activeChannels.includes("email")) {
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
