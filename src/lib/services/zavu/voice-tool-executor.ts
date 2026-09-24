import { v5 as uuidv5 } from "uuid";
import { getApiBaseUrl } from "@/app/api/agents/tools/utils/fetch-helper";
import {
  getCustomerSupportToolDefinitions,
  type CustomerSupportToolDefinition,
} from "@/lib/services/customer-support-tool-catalog";
import { supabaseAdmin } from "@/lib/database/supabase-server";
import { normalizePhoneForStorage } from "@/lib/utils/phone-normalizer";
import { getCustomToolDefinition } from "@/lib/agentbase/agents/toolEvaluator/executor/customToolsMap";

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
  const normalized = normalizePhoneForStorage(phone || "");
  if (!normalized) return undefined;
  const { data, error } = await tenantDatabase()
    .from("leads")
    .select("id")
    .eq("site_id", siteId)
    .eq("phone", normalized)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to resolve Voice tool lead: ${error.message}`);
  return typeof data?.id === "string" ? data.id : undefined;
}

async function resolveConversationId(
  siteId: string,
  leadId: string | undefined
): Promise<string | undefined> {
  if (!leadId) return undefined;
  const { data, error } = await tenantDatabase()
    .from("conversations")
    .select("id")
    .eq("site_id", siteId)
    .eq("lead_id", leadId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to resolve Voice tool conversation: ${error.message}`);
  }
  return typeof data?.id === "string" ? data.id : undefined;
}

async function requireSiteRecord(
  table: "leads" | "conversations",
  siteId: string,
  id: unknown
): Promise<string | undefined> {
  if (typeof id !== "string" || !id) return undefined;
  const { data, error } = await tenantDatabase()
    .from(table)
    .select("id")
    .eq("id", id)
    .eq("site_id", siteId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to validate Voice tool ${table}: ${error.message}`);
  }
  if (data?.id !== id) {
    throw new Error(`Voice tool ${table.slice(0, -1)} does not belong to this site`);
  }
  return id;
}

async function scopeToolArguments(params: {
  tool: CustomerSupportToolDefinition;
  arguments: Record<string, unknown>;
  siteId: string;
  context?: ZavuVoiceToolContext;
}): Promise<Record<string, unknown>> {
  const next = { ...params.arguments };
  const phone = normalizePhoneForStorage(params.context?.contactPhone || "");
  const usesLead = hasParameter(params.tool, "lead_id");
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
  }
  let conversationId = usesConversation
    ? await resolveConversationId(params.siteId, leadId)
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
    if (!response.ok) {
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
  const tool = getCustomerSupportToolDefinitions(params.siteId)
    .find((candidate) => candidate.name === params.toolName);
  if (!tool) throw new Error(`Unknown Customer Support tool "${params.toolName}"`);

  const scopedArguments = await scopeToolArguments({
    tool,
    arguments: params.arguments,
    siteId: params.siteId,
    context: params.context,
  });
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
