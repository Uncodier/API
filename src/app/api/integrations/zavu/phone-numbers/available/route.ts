import { NextRequest, NextResponse } from "next/server";
import { searchAvailableNumbers } from "@/lib/services/zavu";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const countryCode = searchParams.get("countryCode");
    const areaCode = searchParams.get("areaCode");

    if (!countryCode) {
      return NextResponse.json({ error: "countryCode is required" }, { status: 400 });
    }

    const data = await searchAvailableNumbers({ 
      countryCode, 
      areaCode: areaCode || undefined 
    });

    return NextResponse.json(data.items || data.results || data);
  } catch (error: any) {
    console.error("[Zavu PhoneNumbers] Error searching available numbers:", error);
    return NextResponse.json(
      { error: error.message || "Failed to search phone numbers" },
      { status: error.status || 500 }
    );
  }
}
