import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  assertPhoneResourcesAvailable,
  filterPhoneNumbersForSite,
  getOwnedNumbers,
  purchaseNumber,
  requireZavuSiteManager,
} from "@/lib/services/zavu";

const purchaseSchema = z.object({
  siteId: z.string().uuid(),
  phoneNumber: z.string().trim().min(5).max(30),
});

export async function GET(request: NextRequest) {
  try {
    const siteId = request.nextUrl.searchParams.get("siteId");
    if (!siteId || !z.string().uuid().safeParse(siteId).success) {
      return NextResponse.json({ error: "Invalid siteId" }, { status: 400 });
    }
    await requireZavuSiteManager(request, siteId);

    const data = await getOwnedNumbers();
    const results = data?.items || data?.results || (Array.isArray(data) ? data : []);
    return NextResponse.json(await filterPhoneNumbersForSite(siteId, results));
  } catch (error: any) {
    console.error("[Zavu PhoneNumbers] Error fetching owned numbers:", error);
    return NextResponse.json(
      { error: error.status ? error.message : "Failed to fetch owned phone numbers" },
      { status: error.status || 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const parsed = purchaseSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid phone-number purchase request" }, { status: 400 });
    }
    const { siteId, phoneNumber } = parsed.data;
    await requireZavuSiteManager(request, siteId);
    await assertPhoneResourcesAvailable(siteId, { phoneNumber });

    const data = await purchaseNumber(phoneNumber);
    return NextResponse.json({ success: true, data });
  } catch (error: any) {
    console.error("[Zavu PhoneNumbers] Error purchasing number:", error);
    return NextResponse.json(
      { error: error.status ? error.message : "Failed to purchase phone number" },
      { status: error.status || 500 }
    );
  }
}
