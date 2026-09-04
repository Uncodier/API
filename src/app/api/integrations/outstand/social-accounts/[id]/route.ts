import { NextResponse } from "next/server";
import { getOutstandClient } from "@/lib/integrations/outstand/client";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { searchParams } = new URL(request.url);
    const tenantId = searchParams.get("tenant_id") || searchParams.get("tenantId") || undefined;
    const params = await context.params;
    if (!params.id) {
      return NextResponse.json({ success: false, error: "Account ID is required" }, { status: 400 });
    }

    const client = getOutstandClient();
    const result = await client.deleteSocialAccount(params.id, tenantId);
    return NextResponse.json({ success: true, ...result });
  } catch (error: any) {
    const status = error.status || 500;
    return NextResponse.json(
      { success: false, error: error.message || "Failed to delete social account" },
      { status }
    );
  }
}
