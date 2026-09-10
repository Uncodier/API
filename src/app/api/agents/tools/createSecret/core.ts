import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/database/supabase-client";
import { encryptToken } from "@/lib/utils/token-encryption";

export interface CreateSecretParams {
  name: string;
  provider: string;
  use_case: string;
  secret: string;
}

/**
 * Core function to create a secret using site_secrets (AES-256 encrypted)
 * @param site_id - The ID of the site
 * @param instance_id - The ID of the current instance, if any
 * @param params - The secret parameters
 * @returns Result object with success status and details
 */
export async function createSecretCore(
  site_id: string,
  instance_id: string | null,
  params: CreateSecretParams,
) {
  try {
    console.log(
      `[CreateSecret] 🔐 Creating secret "${params.name}" for site: ${site_id}`,
    );

    // Check required fields
    if (
      !params.name ||
      !params.secret ||
      !params.provider ||
      !params.use_case
    ) {
      return {
        success: false,
        message: "Name, provider, use_case and secret are required fields",
      };
    }

    const encryptedValue = encryptToken(params.secret);

    // Look for an existing secret to update, otherwise insert
    let query = supabaseAdmin
      .from("site_secrets")
      .select("id")
      .eq("site_id", site_id)
      .eq("provider", params.provider)
      .eq("use_case", params.use_case);

    if (instance_id) {
      query = query.eq("instance_id", instance_id);
    } else {
      query = query.is("instance_id", null);
    }

    const { data: existingSecret } = await query.maybeSingle();

    let resultData;

    if (existingSecret) {
      const { data, error } = await supabaseAdmin
        .from("site_secrets")
        .update({
          name: params.name,
          encrypted_value: encryptedValue,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existingSecret.id)
        .select("id, name, provider, use_case, created_at, updated_at")
        .single();

      if (error) throw error;
      resultData = data;
    } else {
      const { data, error } = await supabaseAdmin
        .from("site_secrets")
        .insert({
          site_id: site_id,
          instance_id: instance_id || null,
          name: params.name,
          provider: params.provider,
          use_case: params.use_case,
          encrypted_value: encryptedValue,
        })
        .select("id, name, provider, use_case, created_at, updated_at")
        .single();

      if (error) throw error;
      resultData = data;
    }

    console.log(
      `[CreateSecret] ✅ Secret created/updated successfully (AES-256)`,
    );

    return {
      success: true,
      message: "Secret stored securely",
      data: resultData,
    };
  } catch (error: any) {
    console.error(`[CreateSecret] ❌ Unexpected error:`, error);
    return {
      success: false,
      message: error.message || "An unexpected error occurred",
      error: error.message || String(error),
    };
  }
}
