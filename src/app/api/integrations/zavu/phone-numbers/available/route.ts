import { NextRequest, NextResponse } from "next/server";
import { searchAvailableNumbers } from "@/lib/services/zavu";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const countryCode = searchParams.get("countryCode");
    const areaCode = searchParams.get("areaCode");
    const capabilities = searchParams.getAll("capabilities");

    if (!countryCode) {
      return NextResponse.json({ error: "countryCode is required" }, { status: 400 });
    }

    const data = await searchAvailableNumbers({ 
      countryCode, 
      areaCode: areaCode || undefined,
      capabilities: capabilities.length > 0 ? capabilities : undefined
    });

    let results = data.items || data.results || data;

    // Fallback in-memory strict filtering in case Zavu API ignores the capabilities parameter
    if (capabilities.length > 0 && Array.isArray(results)) {
      results = results.filter((num: any) => {
        const numCaps = num.capabilities || [];
        return capabilities.every((cap) => {
          if (Array.isArray(numCaps)) {
            return numCaps.includes(cap);
          }
          return typeof numCaps === "object" && numCaps !== null && numCaps[cap] === true;
        });
      });
    }

    return NextResponse.json(results);
  } catch (error: any) {
    console.error("[Zavu PhoneNumbers] Error searching available numbers:", error);
    return NextResponse.json(
      { error: error.message || "Failed to search phone numbers" },
      { status: error.status || 500 }
    );
  }
}
