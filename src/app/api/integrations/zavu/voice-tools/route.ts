import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";
import { checkZavuSignature } from "@/lib/services/zavu/signature";
import { decryptToken } from "@/lib/utils/token-decryption";
import { getSupabaseAdmin } from "@/lib/database/supabase-server";
import { executeCustomerSupportVoiceTool } from "@/lib/services/zavu/voice-tool-executor";
import { VoiceLeadValidationError } from "@/lib/services/zavu/voice-lead-errors";

const requestSchema = z.object({
  tool: z.string().min(1).optional(),
  arguments: z.record(z.unknown()),
  context: z.object({
    contactPhone: z.string().optional(),
    messageId: z.string().optional(),
    sessionId: z.string().optional(),
  }).passthrough().optional(),
  timestamp: z.number().optional(),
});

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  const startedAt = Date.now();
  let siteId: string | null = null;
  const respond = (body: unknown, status = 200) => NextResponse.json(body, {
    status,
    headers: { "x-request-id": requestId },
  });
  // Allowlisted diagnostic metadata only: never log the body, signature, or secret.
  const log = (event: string, details: Record<string, unknown>, failed = false) => {
    const entry = {
      event,
      request_id: requestId,
      site_id: siteId,
      duration_ms: Date.now() - startedAt,
      ...details,
    };
    if (failed) console.warn("[Zavu Voice Tool]", entry);
    else console.info("[Zavu Voice Tool]", entry);
  };
  try {
    const rawBody = await request.text();
    const signature = request.headers.get("x-zavu-signature");
    const headerToolName = request.headers.get("x-zavu-tool")?.trim();
    
    const { searchParams } = new URL(request.url);
    siteId = searchParams.get("siteId");

    if (!siteId || !z.string().uuid().safeParse(siteId).success) {
      siteId = null;
      return respond({ error: "Missing siteId query parameter" }, 400);
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
      log("agent_lookup_failed", { status: agentError ? 503 : 404 }, true);
      return respond(
        { error: agentError ? "Voice tool configuration unavailable" : "Customer Support agent not found" },
        agentError ? 503 : 404
      );
    }

    const encryptedSecret = (agent.configuration as any)?.zavu?.tool_webhook_secret;
    const secret = typeof encryptedSecret === "string" ? decryptToken(encryptedSecret) : null;
    const signatureCheck = checkZavuSignature(signature, rawBody, secret || undefined);
    if (!signatureCheck.valid) {
      log("authentication_failed", {
        status: 401,
        reason: signatureCheck.reason,
        signature_format: signatureCheck.format,
        has_tool_header: Boolean(headerToolName),
        has_timestamp_header: request.headers.has("x-zavu-timestamp"),
        has_authorization_header: request.headers.has("authorization"),
        secret_configured: typeof encryptedSecret === "string" && encryptedSecret.length > 0,
        secret_decryptable: Boolean(secret),
      }, true);
      return respond({ error: "Invalid signature", code: "VOICE_TOOL_AUTH_FAILED", request_id: requestId }, 401);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      log("payload_rejected", { status: 400, reason: "invalid_json" }, true);
      return respond({ error: "Invalid tool payload" }, 400);
    }
    const parsed = requestSchema.safeParse(payload);
    if (!parsed.success) {
      log("payload_rejected", { status: 400, reason: "invalid_schema" }, true);
      return respond({ error: "Invalid tool payload" }, 400);
    }

    if (headerToolName && parsed.data.tool && parsed.data.tool !== headerToolName) {
      log("payload_rejected", { status: 400, reason: "tool_name_mismatch" }, true);
      return respond({ error: "Tool name mismatch" }, 400);
    }
    // Zavu's voice runtime can omit X-Zavu-Tool. The body is trusted only
    // after checking its signature with this site's agent secret.
    const toolName = headerToolName || parsed.data.tool;
    if (!toolName) {
      log("payload_rejected", { status: 400, reason: "missing_tool_name" }, true);
      return respond({ error: "Missing tool name" }, 400);
    }

    // Do not turn caller-controlled fields into arbitrary log content.
    const toolLabel = /^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(toolName)
      ? toolName : "invalid_tool_name";

    try {
      const result = await executeCustomerSupportVoiceTool({
        toolName,
        arguments: parsed.data.arguments,
        context: parsed.data.context,
        siteId,
        rawPayload: rawBody,
      });
      log("execution_completed", { tool: toolLabel, status: 200 });
      return respond(result ?? { success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tool execution failed";
      const unknownTool = message.startsWith("Unknown Customer Support tool");
      const validation = error instanceof VoiceLeadValidationError ? error : undefined;
      const code = validation?.code || (unknownTool ? "UNKNOWN_TOOL" : "TOOL_EXECUTION_FAILED");
      log("execution_failed", {
        tool: unknownTool ? "unknown_tool" : toolLabel,
        status: unknownTool ? 400 : 422,
        code,
        ...(validation ? { invalid_fields: validation.fields } : {}),
      }, true);
      return respond(
        {
          error: message,
          code,
          ...(validation ? { invalid_fields: validation.fields } : {}),
          request_id: requestId,
        },
        unknownTool ? 400 : 422
      );
    }
  } catch {
    log("request_failed", { status: 500 }, true);
    return respond({ error: "Internal server error", request_id: requestId }, 500);
  }
}
