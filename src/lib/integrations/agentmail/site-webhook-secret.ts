import { supabaseAdmin } from "@/lib/database/supabase-server"
import { decryptToken } from "@/lib/utils/token-decryption"

const AGENTMAIL_WEBHOOK_USE_CASE = "webhook"

interface AgentMailWebhookCandidate {
  message?: {
    inbox_id?: unknown
  }
}

export interface AgentMailWebhookVerificationContext {
  secret: string | null | undefined
  siteId: string | null
}

function inboxIdFromUntrustedBody(rawBody: string): string | null {
  try {
    const payload = JSON.parse(rawBody) as AgentMailWebhookCandidate
    const inboxId = payload.message?.inbox_id
    if (typeof inboxId !== "string") return null

    const normalized = inboxId.trim()
    return normalized.length > 0 && normalized.length <= 320 ? normalized : null
  } catch {
    return null
  }
}

async function findSiteIdByInboxPath(
  path: string,
  inboxId: string,
): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("settings")
    .select("site_id")
    .filter(path, "eq", inboxId)
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error("[AgentMail] Failed to resolve webhook inbox owner:", error)
    return null
  }

  return typeof data?.site_id === "string" ? data.site_id : null
}

export async function findAgentMailSiteIdByInbox(
  inboxId: string,
): Promise<string | null> {
  return (
    await findSiteIdByInboxPath("channels->agent_email->>inbox_id", inboxId)
  ) || (
    await findSiteIdByInboxPath("channels->agent_email->data->>inbox_id", inboxId)
  )
}

export async function resolveAgentMailWebhookVerificationContext(
  rawBody: string,
  fallbackSecret?: string,
): Promise<AgentMailWebhookVerificationContext> {
  const inboxId = inboxIdFromUntrustedBody(rawBody)
  if (!inboxId) return { secret: fallbackSecret, siteId: null }

  const siteId = await findAgentMailSiteIdByInbox(inboxId)
  if (!siteId) return { secret: fallbackSecret, siteId: null }

  const { data, error } = await supabaseAdmin
    .from("site_secrets")
    .select("encrypted_value")
    .eq("site_id", siteId)
    .eq("provider", "agentmail")
    .eq("use_case", AGENTMAIL_WEBHOOK_USE_CASE)
    .is("instance_id", null)
    .maybeSingle()

  if (error) {
    console.error("[AgentMail] Failed to load the site webhook secret:", error)
    return { secret: null, siteId }
  }
  if (!data?.encrypted_value) {
    return { secret: fallbackSecret, siteId }
  }

  return {
    secret: decryptToken(data.encrypted_value),
    siteId,
  }
}
