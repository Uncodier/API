import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  ensureSenderChannelActive,
  isChannelActivationBlocked,
  getChannelConnection,
  requireZavuSiteManager,
} from "@/lib/services/zavu";
import { patchActivationConnection, requireActivationLicense } from "@/lib/services/zavu/activation-persistence";

const activationSchema = z.object({
  siteId: z.string().min(1),
  channelId: z.string().min(1),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let authorized = false;
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
    authorized = true;

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
    if (isChannelActivationBlocked(connection)) {
      return NextResponse.json({ error: "Channel connection is disabled or license-suspended" }, { status: 409 });
    }

    const expected = { type: "email", senderId };
    await requireActivationLicense(siteId, channelId, expected);
    await patchActivationConnection(siteId, channelId, {
      status: connection.status === "connected" ? "connected" : "in_progress",
      metadata: { activation_pending: true, emailChannelActive: false },
    }, expected);

    let activation;
    try {
      await requireActivationLicense(siteId, channelId, expected);
      activation = await ensureSenderChannelActive(senderId, "email");
    } catch (error) {
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

    await requireActivationLicense(siteId, channelId, expected);
    await patchActivationConnection(siteId, channelId, {
      status: "connected",
      metadata: {
        emailChannelActive: true,
        activation_pending: false,
        provider_channel_active: true,
      },
    }, expected);

    return NextResponse.json({
      success: true,
      activated: activation.activated,
      channel: activation.channel,
      chargedCents: activation.chargedCents,
      monthlyCents: activation.monthlyCents,
      sender: { id: activation.sender.id, channels: activation.sender.channels },
    });
  } catch (error: any) {
    const status = !authorized && (error?.status === 401 || error?.status === 403) ? error.status : 500;
    return NextResponse.json(
      { error: status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Failed to activate email channel" },
      { status }
    );
  }
}
