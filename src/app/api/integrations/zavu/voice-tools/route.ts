import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyZavuSignature } from "@/lib/services/zavu/signature";
import { decryptToken } from "@/lib/utils/token-decryption";
import { getSupabaseAdmin } from "@/lib/database/supabase-server";
import { manageLeadCreation } from "@/lib/services/leads/lead-service";

const requestSchema = z.object({
  tool: z.string().optional(),
  arguments: z.record(z.unknown()),
  context: z.record(z.unknown()).optional(),
  timestamp: z.number().optional(),
});

const captureLeadSchema = z.object({
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().min(5).max(30),
  email: z.string().trim().email().max(320).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const signature = request.headers.get("x-zavu-signature");
    const toolName = request.headers.get("x-zavu-tool");
    
    const { searchParams } = new URL(request.url);
    const siteId = searchParams.get("siteId");

    if (!siteId || !z.string().uuid().safeParse(siteId).success) {
      return NextResponse.json({ error: "Missing siteId query parameter" }, { status: 400 });
    }

    if (!toolName) {
      return NextResponse.json({ error: "Missing x-zavu-tool header" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();
    const { data: agent, error: agentError } = await supabase
      .from("agents")
      .select("configuration")
      .eq("site_id", siteId)
      .eq("role", "Customer Support")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (agentError || !agent) {
      return NextResponse.json({ error: "Customer Support agent not found" }, { status: 404 });
    }

    const encryptedSecret = (agent.configuration as any)?.zavu?.tool_webhook_secret;
    const secret = typeof encryptedSecret === "string" ? decryptToken(encryptedSecret) : null;
    if (!verifyZavuSignature(signature, rawBody, secret || undefined)) {
      console.warn(`[Zavu Voice Webhook] Invalid signature for site ${siteId}`);
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    const parsed = requestSchema.safeParse(JSON.parse(rawBody));
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid tool payload" }, { status: 400 });
    }

    if (
      toolName !== "capture_lead"
      || (parsed.data.tool && parsed.data.tool !== toolName)
    ) {
      return NextResponse.json({ error: "Unknown tool" }, { status: 400 });
    }

    const lead = captureLeadSchema.safeParse(parsed.data.arguments);
    if (!lead.success) {
      return NextResponse.json({ error: "Invalid lead information" }, { status: 400 });
    }

    const result = await manageLeadCreation({
      ...lead.data,
      siteId,
      origin: "voice",
      createTask: true,
    });
    if (!result.leadId) {
      return NextResponse.json({ error: "Lead could not be captured" }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      leadId: result.leadId,
      created: result.isNewLead,
      message: result.isNewLead
        ? "Lead captured successfully."
        : "Lead already exists and was matched successfully.",
    });
  } catch (error: any) {
    console.error("[Zavu Voice Webhook] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
