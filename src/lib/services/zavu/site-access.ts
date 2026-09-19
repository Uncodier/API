import type { NextRequest } from "next/server";
import { createSupabaseClient } from "@/lib/database/supabase-server";

export class ZavuAccessError extends Error {
  constructor(
    message: string,
    public readonly status: 401 | 403
  ) {
    super(message);
  }
}

export async function requireZavuSiteAccess(
  request: NextRequest,
  siteId: string
): Promise<string> {
  const supabase = createSupabaseClient(request);
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    throw new ZavuAccessError("Unauthorized", 401);
  }

  const { data: role, error: roleError } = await supabase.rpc(
    "current_user_site_role",
    { p_site_id: siteId }
  );
  if (roleError || typeof role !== "string") {
    throw new ZavuAccessError("Forbidden", 403);
  }
  return role;
}

export async function requireZavuSiteManager(
  request: NextRequest,
  siteId: string
): Promise<void> {
  const role = await requireZavuSiteAccess(request, siteId);
  if (role !== "owner" && role !== "admin") {
    throw new ZavuAccessError("Forbidden", 403);
  }
}
