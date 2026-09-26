import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  getChannelConnection,
  requireZavuSiteManager,
  upsertChannelConnection,
  verifyEmailDomain,
} from "@/lib/services/zavu";

const verificationSchema = z.object({
  siteId: z.string().min(1),
  channelId: z.string().min(1),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: domainId } = await params;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const parsed = verificationSchema.safeParse(body);
    if (!domainId || !parsed.success) {
      return NextResponse.json(
        { error: "domainId, siteId, and channelId are required" },
        { status: 400 }
      );
    }
    const { siteId, channelId } = parsed.data;
    await requireZavuSiteManager(request, siteId);

    const connection = await getChannelConnection(siteId, channelId);
    if (!connection) {
      return NextResponse.json(
        { error: "Email channel connection was not found" },
        { status: 404 }
      );
    }
    if (connection.type !== "email" || connection.metadata?.email_domain_id !== domainId) {
      return NextResponse.json(
        { error: "Domain does not match the email channel connection" },
        { status: 409 }
      );
    }

    let emailDomain;
    try {
      emailDomain = await verifyEmailDomain(domainId);
    } catch (zavuError) {
      console.error("[Zavu] Error verifying email domain:", zavuError);
      return NextResponse.json(
        { error: "Zavu could not verify the email domain" },
        { status: 502 }
      );
    }
    if (!emailDomain || (emailDomain.id && emailDomain.id !== domainId)) {
      return NextResponse.json(
        { error: "Zavu returned an invalid email domain" },
        { status: 502 }
      );
    }

    await upsertChannelConnection(siteId, channelId, {
      metadata: {
        domain_status: emailDomain.status,
        dns_records: emailDomain.dnsRecords || connection.metadata?.dns_records || [],
      },
    });

    return NextResponse.json({ success: true, domain: emailDomain });
  } catch (error: any) {
    console.error("[Zavu] Unhandled error verifying email domain:", error);
    const status = error.status || 500;
    return NextResponse.json(
      { error: status === 401 || status === 403 ? error.message : "Internal server error" },
      { status }
    );
  }
}
