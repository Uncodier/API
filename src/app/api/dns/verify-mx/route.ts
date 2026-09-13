import { NextRequest, NextResponse } from "next/server";
import dns from "dns/promises";

export async function GET(req: NextRequest) {
  const domain = req.nextUrl.searchParams.get("domain");
  if (!domain) {
    return NextResponse.json({ success: false, error: "Domain is required" }, { status: 400 });
  }

  try {
    const records = await dns.resolveMx(domain);
    // Zavu inbound MX record is inbound.zavu.dev
    const hasZavuMx = records.some((r) => r.exchange === "inbound.zavu.dev");
    return NextResponse.json({ success: true, verified: hasZavuMx, records });
  } catch (error) {
    return NextResponse.json({ success: false, verified: false, error: (error as Error).message });
  }
}
