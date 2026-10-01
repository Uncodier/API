import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseClient } from "@/lib/database/supabase-server";
import { deleteSender, detachSenderFromAgent, releaseNumber } from "@/lib/services/zavu";
import { requireZavuSiteAccess } from "@/lib/services/zavu/site-access";
import {
  getWhatsAppSenderDisplay,
  zavuSenderIdSchema,
} from "@/lib/services/zavu/sender-display";

const readHeaders = { "Cache-Control": "private, no-store" };
const connectionSchema = z.object({
  type: z.literal("whatsapp"),
  status: z.literal("connected"),
  enabled: z.literal(true).optional(),
  zavu_sender_id: zavuSenderIdSchema,
});
const channelsSchema = z.object({ connections: z.array(z.unknown()) });

function readError(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: readHeaders });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const siteIds = request.nextUrl.searchParams.getAll("siteId");
    if (siteIds.length !== 1 || !z.string().uuid().safeParse(siteIds[0]).success) {
      return readError("Invalid siteId", 400);
    }
    if (!zavuSenderIdSchema.safeParse(id).success) {
      return readError("Invalid sender ID", 400);
    }
    const siteId = siteIds[0].toLowerCase();

    // This browser read must never select the service-role API-key client.
    if (request.headers.has("x-api-key-data")) return readError("Unauthorized", 401);
    try {
      await requireZavuSiteAccess(request, siteId);
    } catch (error) {
      // Only access-check errors can become 401/403, never provider failures.
      if (error && typeof error === "object" && "status" in error
        && (error.status === 401 || error.status === 403)) {
        return readError(error.status === 401 ? "Unauthorized" : "Forbidden", error.status);
      }
      throw error;
    }

    const supabase = createSupabaseClient(request);
    const { data: settings, error } = await supabase
      .from("settings")
      .select("site_id, channels")
      .eq("site_id", siteId)
      .maybeSingle();
    if (error) return readError("Failed to retrieve WhatsApp sender", 500);

    const channels = channelsSchema.safeParse(settings?.channels);
    const attached = settings?.site_id === siteId && channels.success
      && channels.data.connections.some((candidate) => {
        const connection = connectionSchema.safeParse(candidate);
        return connection.success && connection.data.zavu_sender_id === id;
      });
    if (!attached) return readError("WhatsApp sender not found", 404);

    try {
      const data = await getWhatsAppSenderDisplay(id);
      return NextResponse.json({ success: true, data }, { headers: readHeaders });
    } catch {
      return readError("Failed to retrieve WhatsApp sender", 502);
    }
  } catch {
    return readError("Failed to retrieve WhatsApp sender", 500);
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const searchParams = _request.nextUrl.searchParams;
    const phoneNumber = searchParams.get("phoneNumber");
    if (!id) {
      return NextResponse.json({ error: "Sender ID is required" }, { status: 400 });
    }

    await detachSenderFromAgent(id);
    if (phoneNumber) {
      try {
        await releaseNumber(phoneNumber);
      } catch (e) {
        console.warn("[Zavu] Failed to release number:", e);
      }
    }
    await deleteSender(id);
    return NextResponse.json({ success: true, message: "Sender deleted" });
  } catch (error: any) {
    console.error("[Zavu] Error deleting sender:", error);
    return NextResponse.json(
      { error: error.message || "Failed to delete sender" },
      { status: error.status || 500 }
    );
  }
}
