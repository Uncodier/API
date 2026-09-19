import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireZavuSiteManager, searchAvailableNumbers } from "@/lib/services/zavu";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const siteId = searchParams.get("siteId");
    const countryCode = searchParams.get("countryCode");
    const areaCode = searchParams.get("areaCode");
    const capabilities = searchParams
      .getAll("capabilities")
      .flatMap((value) => value.split(","))
      .filter(Boolean);

    if (!siteId || !z.string().uuid().safeParse(siteId).success || !countryCode) {
      return NextResponse.json(
        { error: "Valid siteId and countryCode are required" },
        { status: 400 }
      );
    }
    await requireZavuSiteManager(request, siteId);

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
      { error: error.status ? error.message : "Failed to search phone numbers" },
      { status: error.status || 500 }
    );
  }
}
