import { supabaseAdmin } from "@/lib/database/supabase-client";
import { decryptToken } from "@/lib/utils/token-decryption";

export interface IntegrationApiRequestParams {
  secret_id: string;
  url: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: any;
  secret_header_name?: string; // e.g. "Authorization"
  secret_header_format?: string; // e.g. "Bearer {secret}"
}

export async function integrationApiRequestCore(
  site_id: string,
  instance_id: string | null = null,
  params: IntegrationApiRequestParams,
) {
  try {
    const {
      secret_id,
      url,
      method,
      headers = {},
      body,
      secret_header_name = "Authorization",
      secret_header_format = "Bearer {secret}",
    } = params;

    // 1. Fetch the secret and verify ownership
    let query = supabaseAdmin
      .from("site_secrets")
      .select("encrypted_value, site_id, instance_id")
      .eq("id", secret_id)
      .eq("site_id", site_id);

    // If an instance is active, allow instance secrets OR site-wide secrets.
    // If no instance is active, ONLY allow site-wide secrets.
    if (instance_id) {
      query = query.or(`instance_id.is.null,instance_id.eq.${instance_id}`);
    } else {
      query = query.is("instance_id", null);
    }

    const { data: secretData, error: secretError } = await query.maybeSingle();

    if (secretError || !secretData || !secretData.encrypted_value) {
      return {
        success: false,
        message: "Secret not found or access denied",
      };
    }

    // 2. Decrypt the secret
    const decryptedSecret = decryptToken(secretData.encrypted_value);

    if (!decryptedSecret) {
      return {
        success: false,
        message: "Failed to decrypt secret",
      };
    }

    // 3. Prepare the request
    const requestHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      ...headers,
    };

    // Inject the secret into the headers
    const headerValue = secret_header_format.replace(
      "{secret}",
      decryptedSecret,
    );
    requestHeaders[secret_header_name] = headerValue;

    const fetchOptions: RequestInit = {
      method,
      headers: requestHeaders,
    };

    if (body && ["POST", "PUT", "PATCH"].includes(method)) {
      fetchOptions.body =
        typeof body === "string" ? body : JSON.stringify(body);
    }

    // 4. Make the external API request
    const response = await fetch(url, fetchOptions);

    let responseData;
    const contentType = response.headers.get("content-type");

    if (contentType && contentType.includes("application/json")) {
      responseData = await response.json();
    } else {
      responseData = await response.text();
    }

    return {
      success: response.ok,
      status: response.status,
      data: responseData,
    };
  } catch (error: any) {
    console.error("[IntegrationApiRequest] ❌ Error:", error);
    return {
      success: false,
      message:
        error.message || "An unexpected error occurred during the API request",
      error: String(error),
    };
  }
}
