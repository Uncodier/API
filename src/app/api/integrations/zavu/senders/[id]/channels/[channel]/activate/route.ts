import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { activateChannelConnection } from "@/lib/services/zavu/connection-activation";
import { isActivatableChannel } from "@/lib/services/zavu/channel-activation";
import { getChannelConnection } from "@/lib/services/zavu/persist";
import { requireZavuSiteManager } from "@/lib/services/zavu/site-access";

const schema = z.object({ siteId: z.string().min(1), channelId: z.string().min(1) }).strict();

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; channel: string }> }) {
  try {
    const { id, channel } = await params;
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!id || !isActivatableChannel(channel) || !parsed.success) {
      return NextResponse.json({ error: "Invalid channel activation request" }, { status: 400 });
    }
    const { siteId, channelId } = parsed.data;
    await requireZavuSiteManager(request, siteId);
    const connection = await getChannelConnection(siteId, channelId);
    if (!connection) return NextResponse.json({ error: "Channel not found" }, { status: 404 });
    if (connection.zavu_sender_id !== id || connection.type !== channel) {
      return NextResponse.json({ error: "Sender does not match the channel connection" }, { status: 409 });
    }
    const result = await activateChannelConnection(siteId, channelId, { senderId: id, type: channel });
    return NextResponse.json({
      success: true,
      activated: result.activation.activated === true,
      chargedCents: result.activation.chargedCents,
      monthlyCents: result.activation.monthlyCents,
      sender: { id, channels: result.activation.sender?.channels || [] },
      status: result.connection.status, activationPending: false,
    });
  } catch (error: any) {
    const status = [401, 403, 409, 502].includes(error?.status) ? error.status : 500;
    return NextResponse.json({ error: status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Channel activation could not be completed", ...(error?.code === "ACCOUNT_LIMIT" ? { code: "ACCOUNT_LIMIT" } : {}) }, { status });
  }
}