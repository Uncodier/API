import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { addEmailDomain, getEmailDomain } from "@/lib/services/zavu/client";
import { requireZavuSiteManager, ZavuAccessError } from "@/lib/services/zavu/site-access";
import {
  DomainConnectionConflict,
  domainIdSchema,
  emailDomainProviderSchema,
  loadDomainConnections,
  normalizeEmailDomain,
  saveDomainFields,
  selectDomainId,
} from "./domain-connections";

const requestSchema = z.object({
  domain: z.string().transform(normalizeEmailDomain).refine((value) => value !== null),
  siteId: domainIdSchema,
  channelId: domainIdSchema,
  name: z.string().trim().max(200).optional().transform((value) => value || undefined),
}).strict();

export async function POST(request: NextRequest) {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success || !parsed.data.domain) {
      return NextResponse.json({ error: "Invalid email domain configuration" }, { status: 400 });
    }
    const { domain, siteId, channelId, name } = parsed.data;
    await requireZavuSiteManager(request, siteId);

    const snapshot = await loadDomainConnections(siteId);
    const storedId = selectDomainId(snapshot.connections, channelId, domain);
    let emailDomain;
    try {
      const reply = storedId
        ? await getEmailDomain(storedId)
        : await addEmailDomain(domain);
      const validated = emailDomainProviderSchema.safeParse(reply);
      if (!validated.success || validated.data.domain !== domain ||
          (storedId && validated.data.id !== storedId)) {
        throw new Error("Invalid provider response");
      }
      // Only return validated domain fields, not unrelated provider data.
      emailDomain = { ...validated.data, domain };
    } catch {
      return NextResponse.json({ error: "Zavu could not confirm the email domain" }, { status: 502 });
    }

    await saveDomainFields(siteId, channelId, name, snapshot, emailDomain);
    return NextResponse.json({ success: true, domain: emailDomain, reused: Boolean(storedId) });
  } catch (error: unknown) {
    if (error instanceof ZavuAccessError) {
      return NextResponse.json(
        { error: error.status === 401 ? "Unauthorized" : "Forbidden" },
        { status: error.status }
      );
    }
    if (error instanceof DomainConnectionConflict) {
      return NextResponse.json({ error: "Email domain connection conflict" }, { status: 409 });
    }
    return NextResponse.json({ error: "Could not save the email domain configuration" }, { status: 500 });
  }
}
