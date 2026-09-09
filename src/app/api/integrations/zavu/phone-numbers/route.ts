import { NextRequest, NextResponse } from "next/server";
import { getOwnedNumbers } from "@/lib/services/zavu";

export async function GET(request: NextRequest) {
  try {
    const data = await getOwnedNumbers();
    // Zavu usually returns paginated results in 'items' or 'results'
    const results = data?.items || data?.results || (Array.isArray(data) ? data : []);
    
    // Filter only those that have 'voice' capability if we want to be strict,
    // but the frontend will show them.
    return NextResponse.json(results);
  } catch (error: any) {
    console.error("[Zavu PhoneNumbers] Error fetching owned numbers:", error);
    return NextResponse.json(
      { error: error.message || "Failed to fetch owned phone numbers" },
      { status: error.status || 500 }
    );
  }
}
