import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isInternalServiceRequest } from "@/lib/security/request-rate-limit";
import { placeTrackedVoiceCall } from "@/lib/services/zavu/voice-call-service";

const requestSchema = z.object({
  to: z.string().trim().regex(/^\+[1-9]\d{6,14}$/),
  message: z.string().trim().min(1).max(1_000),
  site_id: z.string().uuid(),
  message_id: z.string().uuid(),
  agent_id: z.string().uuid().optional(),
  conversation_id: z.string().uuid().optional(),
  lead_id: z.string().uuid().optional(),
  audience_id: z.string().uuid().optional(),
  objective: z.string().trim().min(1).max(500).optional(),
  additional_context: z.string().trim().min(1).max(4_000).optional(),
  language: z.string().trim().min(2).max(15).optional(),
  max_duration_minutes: z.number().int().min(1).max(120).optional(),
}).strict();

export async function POST(request: NextRequest) {
  if (!isInternalServiceRequest(request)) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 }
    );
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Invalid Voice call request" },
      { status: 400 }
    );
  }

  try {
    const result = await placeTrackedVoiceCall({
      siteId: parsed.data.site_id,
      to: parsed.data.to,
      greeting: parsed.data.message,
      messageId: parsed.data.message_id,
      conversationId: parsed.data.conversation_id,
      leadId: parsed.data.lead_id,
      audienceId: parsed.data.audience_id,
      objective: parsed.data.objective,
      additionalContext: parsed.data.additional_context,
      language: parsed.data.language,
      maxDurationMinutes: parsed.data.max_duration_minutes,
    });
    return NextResponse.json({
      success: true,
      callId: result.call.id,
      status: result.call.status,
      deliveryId: result.deliveryId,
      duplicate: result.duplicate,
    }, { status: result.duplicate ? 200 : 202 });
  } catch (error) {
    const status =
      error && typeof error === "object" && "status" in error
      && typeof error.status === "number"
        ? error.status
        : 502;
    const safeStatus = status >= 400 && status <= 599 ? status : 502;
    const message =
      safeStatus >= 500
        ? "Failed to place Voice call"
        : error instanceof Error ? error.message : "Voice call request failed";
    console.error("[Voice Call] Placement failed:", error);
    return NextResponse.json(
      { success: false, error: message },
      { status: safeStatus }
    );
  }
}
