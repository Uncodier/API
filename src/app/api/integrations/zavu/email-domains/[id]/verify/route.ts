import { NextRequest, NextResponse } from "next/server";
import { verifyEmailDomain, upsertChannelConnection } from "@/lib/services/zavu";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: domainId } = await params;
    if (!domainId) {
      return NextResponse.json({ error: "domainId is required" }, { status: 400 });
    }

    let emailDomain;
    try {
      emailDomain = await verifyEmailDomain(domainId);
    } catch (zavuError: any) {
      console.error("[Zavu] Error verifying email domain:", zavuError);
      return NextResponse.json(
        { error: `Zavu API Error: ${zavuError.message || "Unknown error"}` },
        { status: 502 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const { siteId, channelId } = body || {};

    if (siteId && channelId) {
      await upsertChannelConnection(siteId, channelId, {
        metadata: {
          domain_status: emailDomain.status,
          dns_records: emailDomain.dnsRecords,
        },
      });
    }

    return NextResponse.json({ success: true, domain: emailDomain });
  } catch (error: any) {
    console.error("[Zavu] Unhandled error verifying email domain:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
