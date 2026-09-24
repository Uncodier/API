import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyZavuSignature } from "@/lib/services/zavu/signature";
import { decryptToken } from "@/lib/utils/token-decryption";
import { getSupabaseAdmin } from "@/lib/database/supabase-server";
import { executeCustomerSupportVoiceTool } from "@/lib/services/zavu/voice-tool-executor";

const requestSchema = z.object({
  tool: z.string().optional(),
  arguments: z.record(z.unknown()),
  context: z.object({
    contactPhone: z.string().optional(),
    messageId: z.string().optional(),
    sessionId: z.string().optional(),
  }).passthrough().optional(),
  timestamp: z.number().optional(),
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

    if (parsed.data.tool && parsed.data.tool !== toolName) {
      return NextResponse.json({ error: "Tool name mismatch" }, { status: 400 });
    }

    try {
      const result = await executeCustomerSupportVoiceTool({
        toolName,
        arguments: parsed.data.arguments,
        context: parsed.data.context,
        siteId,
        rawPayload: rawBody,
      });
      return NextResponse.json(result ?? { success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tool execution failed";
      const unknownTool = message.startsWith("Unknown Customer Support tool");
      return NextResponse.json(
        {
          error: message,
          code: unknownTool ? "UNKNOWN_TOOL" : "TOOL_EXECUTION_FAILED",
        },
        { status: unknownTool ? 400 : 422 }
      );
    }
  } catch (error: any) {
    console.error("[Zavu Voice Webhook] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
