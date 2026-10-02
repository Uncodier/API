import { v5 as uuidv5 } from "uuid";
import { z } from "zod";
import { getApiBaseUrl } from "@/app/api/agents/tools/utils/fetch-helper";
import type { CustomerSupportToolDefinition } from "@/lib/services/customer-support-tool-catalog";
import { getCustomerSupportVoiceToolDefinitions } from "./voice-tool-catalog";
import { validateVoiceToolArguments, VoiceToolArgumentValidationError } from "./voice-tool-parameters";
import { identifyVoiceLead, normalizeVoiceIdentityPhone } from "./voice-lead-identification";
import { findInboundVoiceLead } from "./inbound-voice-lead";
import { getVoiceCall } from "./voice-call-client";
import { supabaseAdmin } from "@/lib/database/supabase-server";
import { getCustomToolDefinition } from "@/lib/agentbase/agents/toolEvaluator/executor/customToolsMap";
import { loadVoiceExecutionContext } from './voice-execution-context';

const VOICE_TOOL_TIMEOUT_MS = 8_500;

export type ZavuVoiceToolContext = {
  contactPhone?: string;
  messageId?: string;
  sessionId?: string;
  [key: string]: unknown;
};

function tenantDatabase() {
  return supabaseAdmin.schema(
    process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA
    || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA
    || "public"
  );
}

function hasParameter(
  tool: CustomerSupportToolDefinition,
  parameter: string
): boolean {
  const properties = tool.parameters?.properties;
  return Boolean(
    properties
    && typeof properties === "object"
    && parameter in (properties as Record<string, unknown>)
  );
}

async function resolveLeadId(
  siteId: string,
  phone: string | undefined
): Promise<string | undefined> {
  const normalized = normalizeVoiceIdentityPhone(phone);
  if (!normalized) return undefined;
  return findInboundVoiceLead(siteId, normalized);
}

async function requireSiteRecord(
  table: "leads" | "conversations",
  siteId: string,
  id: unknown,
  field = table === "leads" ? "lead_id" : "conversation_id"
): Promise<string | undefined> {
  if (id === undefined) return undefined;
  if (!z.string().uuid().safeParse(id).success) {
    throw new VoiceToolArgumentValidationError([
      { field, requirement: "use a returned UUID, or omit the field; never invent an ID." },
    ]);
  }
  const { data, error } = await tenantDatabase()
    .from(table)
    .select("id")
    .eq("id", id)
    .eq("site_id", siteId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to validate Voice tool ${table}`);
  }
  if (data?.id !== id) {
    throw new Error(`Voice tool ${table.slice(0, -1)} does not belong to this site`);
  }
  return id as string;
}

/** Only transport-level absence, never coerce a supplied value or catalog null=unlimited. */
function omitEmptyOptionalArguments(tool: CustomerSupportToolDefinition, args: Record<string, unknown>) {
  const next = { ...args };
  const required = new Set(tool.parameters.required as string[] || []);
  for (const field of Object.keys(tool.parameters.properties || {})) {
    const value = next[field];
    if (!required.has(field) && (value === null || (typeof value === "string" && !value.trim()))) {
      delete next[field];
    }
  }
  return next;
}

async function resolveLiveConversation(siteId: string, contactPhone?: string): Promise<{
  conversationId: string; deliveryId: string; messageId?: string; direction: 'inbound' | 'outbound';
}> {
  const phone = normalizeVoiceIdentityPhone(contactPhone);
  if (!phone) throw new Error("Trusted Voice caller context is required for human assistance");
  // sessionId is opaque in Zavu's documented contract, not necessarily a call ID.
  // Only the unique active delivery for the signed caller can select a conversation.
  const { data, error } = await tenantDatabase().from("voice_call_deliveries")
    .select("id, message_id, conversation_id, zavu_call_id, zavu_sender_id")
    .eq("site_id", siteId).eq("recipient_phone", phone)
    .in("status", ["queued", "initiated", "ringing", "answered", "in_progress"])
    .is("ended_at", null).limit(2);
  if (error) throw new Error("Unable to resolve the active Voice call");
  if (!data?.length) throw new Error("Active Voice call context is not ready; retry human assistance shortly");
  if (data.length !== 1 || !data[0].zavu_call_id || !z.string().uuid().safeParse(data[0].id).success) {
    throw new Error("Ambiguous active Voice call; cannot choose a conversation for human assistance");
  }
  const conversationId = data[0].conversation_id;
  if (!z.string().uuid().safeParse(conversationId).success) throw new Error("Invalid active Voice conversation");
  // A missed terminal webhook can leave an old delivery marked active. Verify
  // the candidate with the provider instead of routing a new caller to it.
  let call;
  try {
    call = await getVoiceCall(data[0].zavu_call_id, { signal: AbortSignal.timeout(2_000) });
  } catch {
    throw new Error("Unable to verify the live Voice call; retry human assistance shortly");
  }
  const providerPhone = call.direction === "inbound" ? call.from : call.direction === "outbound" ? call.to : undefined;
  if (call.id !== data[0].zavu_call_id || (call.senderId != null && call.senderId !== data[0].zavu_sender_id)
    || normalizeVoiceIdentityPhone(providerPhone) !== phone || call.endedAt
    || !["initiated", "ringing", "answered", "in_progress"].includes(call.status)) {
    throw new Error("Voice call is no longer active or does not match the caller; cannot request assistance on an old call");
  }
  const { data: conversation, error: conversationError } = await tenantDatabase().from("conversations")
    .select("id").eq("id", conversationId).eq("site_id", siteId).maybeSingle();
  if (conversationError || conversation?.id !== conversationId) {
    throw new Error("Unable to verify the active Voice conversation");
  }
  // Outbound deliveries can reuse an existing chat/email conversation. The
  // persisted delivery is the call binding, not the conversation's channel.
  return { conversationId, deliveryId: data[0].id, messageId: data[0].message_id, direction: call.direction };
}

async function scopeToolArguments(params: {
  tool: CustomerSupportToolDefinition;
  arguments: Record<string, unknown>;
  siteId: string;
  context?: ZavuVoiceToolContext;
}): Promise<Record<string, unknown>> {
  const next = params.tool.name === "scheduling"
    ? omitEmptyOptionalArguments(params.tool, params.arguments) : { ...params.arguments };
  if (params.tool.name === "scheduling" && next.action === "check_availability") {
    // Availability does not require identity. Never let empty lead aliases block it.
    delete next.lead_id;
    delete next.context_id;
    return next;
  }
  const phone = normalizeVoiceIdentityPhone(params.context?.contactPhone);
  const usesLeadContext = params.tool.name === "scheduling"
    && hasParameter(params.tool, "context_id");
  const usesLead = hasParameter(params.tool, "lead_id") || usesLeadContext;
  const usesConversation =
    hasParameter(params.tool, "conversation_id")
    || hasParameter(params.tool, "conversation");
  let leadId = usesLead || usesConversation
    ? await resolveLeadId(params.siteId, phone)
    : undefined;
  if (!leadId && usesLead) {
    leadId = await requireSiteRecord(
      "leads",
      params.siteId,
      next.lead_id
    );
    if (usesLeadContext && next.context_id !== undefined) {
      const contextLeadId = await requireSiteRecord("leads", params.siteId, next.context_id, "context_id");
      if (leadId && contextLeadId !== leadId) {
        throw new Error("Voice scheduling lead and context must identify the same lead");
      }
      leadId = contextLeadId;
    }
  }
  if (usesLeadContext && ["list", "schedule"].includes(next.action as string) && !leadId) {
    // An unfiltered appointment list would expose other callers' appointments.
    throw new VoiceToolArgumentValidationError([{
      field: "context_id",
      requirement: "identify the caller with IDENTIFY_LEAD first, then use its returned lead_id. Availability can be checked without identity.",
    }]);
  }
  // All conversation-aware tools use the verified live call, never whichever
  // chat/email conversation happened to be updated most recently for this lead.
  let conversationId = usesConversation && phone
    ? (await resolveLiveConversation(params.siteId, phone)).conversationId
    : undefined;
  if (!conversationId && usesConversation) {
    conversationId = await requireSiteRecord(
      "conversations",
      params.siteId,
      next.conversation_id || next.conversation
    );
  }

  if (hasParameter(params.tool, "site_id")) next.site_id = params.siteId;
  if (hasParameter(params.tool, "phone") && phone) {
    next.phone = phone;
  }
  if (usesLead && leadId) {
    next.lead_id = leadId;
  }
  if (usesLeadContext && leadId) next.context_id = leadId;
  if (
    hasParameter(params.tool, "conversation_id")
    && conversationId
  ) {
    next.conversation_id = conversationId;
  }
  if (
    hasParameter(params.tool, "conversation")
    && conversationId
  ) {
    next.conversation = conversationId;
  }
  return next;
}

function errorMessage(data: any, fallback: string): string {
  if (typeof data?.error === "string") return data.error;
  if (typeof data?.error?.message === "string") return data.error.message;
  if (typeof data?.message === "string") return data.message;
  return fallback;
}

async function executeCustomTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const config = getCustomToolDefinition(toolName);
  if (!config) throw new Error(`No executor is registered for tool "${toolName}"`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VOICE_TOOL_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(config.endpoint.headers || {}),
    };
    if (process.env.SERVICE_API_KEY) {
      headers["x-api-key"] = process.env.SERVICE_API_KEY;
    }
    const response = await fetch(`${getApiBaseUrl()}${config.endpoint.url}`, {
      method: config.endpoint.method,
      headers,
      body: config.endpoint.method === "GET" ? undefined : JSON.stringify(args),
      signal: controller.signal,
    });
    const text = await response.text();
    let data: any = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Tool "${toolName}" returned invalid JSON`);
    }
    if (!response.ok || data?.success === false) {
      throw new Error(errorMessage(data, `Tool "${toolName}" failed`));
    }
    return data;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Tool "${toolName}" timed out`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function executeCustomerSupportVoiceTool(params: {
  toolName: string;
  arguments: Record<string, unknown>;
  siteId: string;
  context?: ZavuVoiceToolContext;
  rawPayload: string;
}): Promise<unknown> {
  const tool = getCustomerSupportVoiceToolDefinitions(params.siteId)
    .find((candidate) => candidate.name === params.toolName);
  if (!tool) throw new Error(`Unknown Customer Support tool "${params.toolName}"`);

  if (tool.name === 'get_call_context') {
    validateVoiceToolArguments(tool, params.arguments);
    const live = await resolveLiveConversation(params.siteId, params.context?.contactPhone);
    if (!live.messageId) throw new Error('Voice execution context is not ready; retry shortly');
    return loadVoiceExecutionContext({
      siteId: params.siteId, conversationId: live.conversationId,
      messageId: live.messageId, direction: live.direction,
    });
  }

  if (tool.name === "IDENTIFY_LEAD") {
    // Live voice has no browser visitor/conversation. Preserve the original
    // supplied phone for confirmation rather than silently replacing it during
    // generic argument scoping, and never call the browser identify endpoint.
    return identifyVoiceLead({
      siteId: params.siteId,
      contactPhone: params.context?.contactPhone,
      arguments: params.arguments,
    });
  }

  if (tool.name === "CONTACT_HUMAN") {
    const args = omitEmptyOptionalArguments(tool, params.arguments);
    // Legacy providers may still send these fields. They never authorize scope.
    delete args.lead_id;
    delete args.conversation_id;
    validateVoiceToolArguments(tool, args);
    const { conversationId, deliveryId } = await resolveLiveConversation(params.siteId, params.context?.contactPhone);
    const result: any = await executeCustomTool(tool.name, {
      ...args, conversation_id: conversationId, voice_call_delivery_id: deliveryId,
    });
    if (result?.success !== true) throw new Error("Human assistance was not confirmed; retry shortly");
    // Do not return staff email addresses or other internal notification details to the voice model.
    return {
      success: true,
      status: "pending",
      conversation_id: conversationId,
      intervention_id: result?.data?.intervention_id,
      message: "Human assistance requested. This is a pending request, not a live transfer or a confirmed callback.",
    };
  }

  const scopedArguments = await scopeToolArguments({
    tool,
    arguments: params.arguments,
    siteId: params.siteId,
    context: params.context,
  });
  validateVoiceToolArguments(tool, scopedArguments);
  const executionArguments = {
    ...scopedArguments,
    command_id: uuidv5(
      `zavu-voice-tool:${params.siteId}:${params.toolName}:${params.rawPayload}`,
      uuidv5.URL
    ),
  };
  if (tool.execute) {
    return tool.execute(executionArguments);
  }
  return executeCustomTool(params.toolName, executionArguments);
}
