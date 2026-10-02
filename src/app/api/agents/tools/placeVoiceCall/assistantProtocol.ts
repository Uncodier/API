import { v5 as uuidv5 } from "uuid";
import { getLeadById } from "@/lib/database/lead-db";
import { supabaseAdmin } from "@/lib/database/supabase-server";
import { placeTrackedVoiceCall } from "@/lib/services/zavu/voice-call-service";
import { buildToolExecutionContext, readToolExecutionContext, sanitizeToolContextText, type ToolExecutionContext } from "@/lib/services/tool-execution-context";

const E164_PHONE = /^\+[1-9]\d{6,14}$/;

export interface PlaceVoiceCallToolParams {
  lead_id: string;
  idempotency_key: string;
  greeting: string;
  objective?: string;
  additional_context?: string;
  language?: string;
  max_duration_minutes?: number;
}

export function placeVoiceCallTool(siteId: string, userId?: string) {
  return {
    name: "placeVoiceCall",
    description:
      "Place one real two-way Zavu voice-agent call to a lead in this site who has not opted out of calls. " +
      "The greeting is spoken when the call connects. objective and additional_context " +
      "are private instructions loaded by the voice agent and are not spoken verbatim.",
    parameters: {
      type: "object",
      properties: {
        lead_id: {
          type: "string",
          description: "UUID of the site lead to call. Do-not-call, revoked, and legacy denied call preferences block placement.",
        },
        idempotency_key: {
          type: "string",
          minLength: 8,
          maxLength: 200,
          description:
            "Stable unique key for this intended call. Reuse the same key on every retry.",
        },
        greeting: {
          type: "string",
          maxLength: 1000,
          description: "Short opening line spoken when the recipient answers.",
        },
        objective: {
          type: "string",
          maxLength: 500,
          description: "Private, specific outcome the voice agent should pursue during this call.",
        },
        additional_context: {
          type: "string",
          maxLength: 4000,
          description: "Private supporting facts, constraints, and relevant background for this call.",
        },
        language: {
          type: "string",
          description: "Optional BCP-47 language tag, or auto.",
        },
        max_duration_minutes: {
          type: "number",
          minimum: 1,
          maximum: 120,
          description: "Optional maximum call duration.",
        },
      },
      required: ["lead_id", "idempotency_key", "greeting", "objective"],
    },
    execute: async (args: PlaceVoiceCallToolParams, executionContext?: ToolExecutionContext) => {
      const idempotencyKey = args.idempotency_key?.trim();
      const greeting = args.greeting?.trim();
      const objective = args.objective?.trim();
      const additionalContext = args.additional_context?.trim();
      const inherited = readToolExecutionContext(executionContext, siteId);
      if (!args.lead_id || !idempotencyKey || !greeting || (!objective && !inherited?.intent)) {
        throw new Error(
          "lead_id, idempotency_key, greeting, and objective are required"
        );
      }
      if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
        throw new Error("idempotency_key must contain 8 to 200 characters");
      }
      if (greeting.length > 1_000) {
        throw new Error("greeting must not exceed 1000 characters");
      }
      if (objective && objective.length > 500) {
        throw new Error("objective must not exceed 500 characters");
      }
      if (additionalContext && additionalContext.length > 4_000) {
        throw new Error("additional_context must not exceed 4000 characters");
      }
      if (
        args.max_duration_minutes !== undefined
        && (!Number.isInteger(args.max_duration_minutes)
          || args.max_duration_minutes < 1
          || args.max_duration_minutes > 120)
      ) {
        throw new Error("max_duration_minutes must be an integer from 1 to 120");
      }
      const safeObjective = sanitizeToolContextText(objective, 500);
      const safeAdditionalContext = sanitizeToolContextText(additionalContext, 4_000);
      if (!safeObjective && !inherited?.intent) {
        throw new Error("lead_id, idempotency_key, greeting, and objective are required");
      }

      const lead = await getLeadById(args.lead_id);
      if (!lead || lead.site_id !== siteId) {
        throw new Error("Lead was not found in this site");
      }
      const phone = lead.phone?.replace(/[^\d+]/g, "") || "";
      if (!E164_PHONE.test(phone)) {
        throw new Error("Lead phone must use E.164 format");
      }

      const callIdentity = `${siteId}:${lead.id}:${idempotencyKey}`;
      const conversationId = uuidv5(`voice-conversation:${callIdentity}`, uuidv5.URL);
      const messageId = uuidv5(`voice-message:${callIdentity}`, uuidv5.URL);
      const envelope = buildToolExecutionContext({
        site_id: siteId,
        intent: safeObjective || inherited?.intent,
        background: safeAdditionalContext || inherited?.background,
        source: { ...inherited?.source, tool: 'placeVoiceCall' },
      });
      const contextData = {
        source: "placeVoiceCall",
        voice_mode: "agent_call",
        voice_call_idempotency_key: idempotencyKey,
        ...(safeObjective ? { voice_objective: safeObjective } : {}),
        ...(safeAdditionalContext
          ? { voice_additional_context: safeAdditionalContext }
          : {}),
      };
      const { error: conversationError } = await supabaseAdmin
        .from("conversations")
        .upsert({
          id: conversationId,
          site_id: siteId,
          lead_id: lead.id,
          channel: "voice",
          title: safeObjective ? `Voice call: ${safeObjective}`.slice(0, 255) : 'Voice call',
          custom_data: contextData,
          ...(userId ? { user_id: userId } : {}),
        }, { onConflict: "id", ignoreDuplicates: true });
      if (conversationError) {
        throw new Error("Failed to create the Voice call conversation");
      }

      const { error: messageError } = await supabaseAdmin
        .from("messages")
        .upsert({
          id: messageId,
          conversation_id: conversationId,
          lead_id: lead.id,
          role: "assistant",
          content: greeting,
          custom_data: {
            ...contextData,
            ...(envelope ? { tool_execution_context: envelope } : {}),
            status: "placing",
          },
        }, { onConflict: "id", ignoreDuplicates: true });
      if (messageError) {
        throw new Error("Failed to create the Voice call message");
      }

      const result = await placeTrackedVoiceCall({
        siteId,
        to: phone,
        greeting,
        messageId,
        conversationId,
        leadId: lead.id,
        objective: safeObjective,
        additionalContext: safeAdditionalContext,
        language: args.language,
        maxDurationMinutes: args.max_duration_minutes,
      });
      return {
        success: true,
        call_id: result.call.id,
        status: result.call.status,
        delivery_id: result.deliveryId,
        conversation_id: conversationId,
        message_id: messageId,
        duplicate: result.duplicate,
      };
    },
  };
}
