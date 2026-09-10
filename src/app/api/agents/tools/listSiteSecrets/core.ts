import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/database/supabase-client";

export interface ListSiteSecretsParams {
  provider?: string;
  use_case?: string;
}

export async function listSiteSecretsCore(
  site_id: string,
  instance_id: string | null = null,
  params: ListSiteSecretsParams = {},
) {
  try {
    let query = supabaseAdmin
      .from("site_secrets")
      .select("id, name, provider, use_case, is_active, created_at, updated_at")
      .eq("site_id", site_id);

    if (instance_id) {
      // If we have an instance ID, we typically want secrets for this instance AND site-wide secrets
      query = query.or(`instance_id.is.null,instance_id.eq.${instance_id}`);
    } else {
      query = query.is("instance_id", null);
    }

    if (params.provider) {
      query = query.eq("provider", params.provider);
    }

    if (params.use_case) {
      query = query.eq("use_case", params.use_case);
    }

    const { data: secrets, error } = await query;

    if (error) {
      throw error;
    }

    return {
      success: true,
      data: secrets || [],
    };
  } catch (error: any) {
    console.error("[ListSiteSecrets] ❌ Error:", error);
    return {
      success: false,
      message: error.message || "An unexpected error occurred",
      error: String(error),
    };
  }
}
