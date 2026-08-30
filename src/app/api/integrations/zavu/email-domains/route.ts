import { NextRequest, NextResponse } from "next/server";
import { addEmailDomain, upsertChannelConnection } from "@/lib/services/zavu";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { domain, siteId, channelId: existingChannelId, name } = body;

    if (!domain) {
      return NextResponse.json({ error: "domain is required" }, { status: 400 });
    }

    let emailDomain;
    try {
      emailDomain = await addEmailDomain(domain);
    } catch (zavuError: any) {
      console.error("[Zavu] Error adding email domain:", zavuError);
      return NextResponse.json(
        { error: `Zavu API Error: ${zavuError.message || "Unknown error"}` },
        { status: 502 }
      );
    }

    if (siteId) {
      await upsertChannelConnection(siteId, existingChannelId, {
        type: "email",
        name: name || "Email Channel",
        status: "pending",
        metadata: {
          email_domain_id: emailDomain.id,
          domain: emailDomain.domain,
          domain_status: emailDomain.status || "pending",
          dns_records: emailDomain.dnsRecords || [],
        },
      });
    }

    return NextResponse.json({ success: true, domain: emailDomain });
  } catch (error: any) {
    console.error("[Zavu] Unhandled error adding email domain:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
