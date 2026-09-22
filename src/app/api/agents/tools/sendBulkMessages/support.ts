import { supabaseAdmin } from "@/lib/database/supabase-client";
import { getContentById } from "@/lib/database/content-db";
import type { ContentPlaceholderPolicy } from "@/lib/messaging/lead-merge-fields";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function findActiveSalesAgent(
  siteId: string
): Promise<{ agentId: string; userId: string } | null> {
  if (!siteId || !UUID.test(siteId)) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from("agents")
      .select("id, user_id")
      .eq("site_id", siteId)
      .eq("role", "Sales")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1);
    if (error || !data?.length) return null;
    return { agentId: data[0].id, userId: data[0].user_id };
  } catch {
    return null;
  }
}

export async function resolvePlaceholderPolicy(
  contentId: string | undefined,
  override: ContentPlaceholderPolicy | undefined
): Promise<ContentPlaceholderPolicy> {
  if (override) return override;
  if (!contentId) return "strip_tokens";
  const row = await getContentById(contentId);
  const placeholders =
    row?.metadata && typeof row.metadata === "object"
      ? (row.metadata as Record<string, unknown>).placeholders
      : undefined;
  if (
    placeholders
    && typeof placeholders === "object"
    && "when_unresolved" in placeholders
  ) {
    const policy = (placeholders as { when_unresolved?: string }).when_unresolved;
    if (policy === "skip_recipient" || policy === "strip_tokens") return policy;
  }
  return "strip_tokens";
}
