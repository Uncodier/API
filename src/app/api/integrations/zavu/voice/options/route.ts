import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  getCustomerSupportVoicePreferences,
  listAgentVoices,
  requireZavuSiteAccess,
} from "@/lib/services/zavu";

const languageSchema = z
  .string()
  .trim()
  .min(2)
  .max(35)
  .regex(/^(?:auto|[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/);

export async function GET(request: NextRequest) {
  try {
    const siteId = request.nextUrl.searchParams.get("siteId");
    if (!siteId || !z.string().uuid().safeParse(siteId).success) {
      return NextResponse.json({ error: "Invalid siteId" }, { status: 400 });
    }
    const language = request.nextUrl.searchParams.get("language") || undefined;
    if (language && !languageSchema.safeParse(language).success) {
      return NextResponse.json({ error: "Invalid language" }, { status: 400 });
    }

    await requireZavuSiteAccess(request, siteId);
    const [catalog, preferences] = await Promise.all([
      listAgentVoices(language),
      getCustomerSupportVoicePreferences(siteId),
    ]);
    return NextResponse.json({ ...catalog, preferences });
  } catch (error: any) {
    console.error("[Zavu Voice] Error fetching Voice options:", error);
    return NextResponse.json(
      {
        error: error.status
          ? error.message
          : "Failed to fetch Voice options",
      },
      { status: error.status || 500 }
    );
  }
}
