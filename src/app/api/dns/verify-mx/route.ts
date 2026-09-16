import { NextRequest, NextResponse } from "next/server";
import dns from "dns/promises";

const ZAVU_INBOUND_MX_HOST = "inbound-smtp.us-east-1.amazonaws.com";

export async function GET(req: NextRequest) {
  const domain = req.nextUrl.searchParams.get("domain");
  if (!domain) {
    return NextResponse.json({ success: false, error: "Domain is required" }, { status: 400 });
  }

  try {
    const records = await dns.resolveMx(domain);
    const hasZavuMx = records.some(
      (record) =>
        record.exchange.toLowerCase().replace(/\.$/, "") === ZAVU_INBOUND_MX_HOST
    );
    return NextResponse.json({ success: true, verified: hasZavuMx, records });
  } catch (error) {
    return NextResponse.json({ success: false, verified: false, error: (error as Error).message });
  }
}
