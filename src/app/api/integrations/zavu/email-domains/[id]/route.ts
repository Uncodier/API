import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getEmailDomain } from "@/lib/services/zavu/client";
import { requireZavuSiteManager, ZavuAccessError } from "@/lib/services/zavu/site-access";
import {
  DomainConnectionConflict,
  domainIdSchema,
  emailDomainProviderSchema,
  loadDomainConnections,
  normalizeEmailDomain,
  saveDomainFields,
} from "../domain-connections";

const querySchema = z.object({ siteId: domainIdSchema, channelId: domainIdSchema }).strict();

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

function sameJson(left: unknown, right: unknown): boolean {
  // JSONB/provider object key order is not meaningful; DNS array order is.
  const sortedKeys = (_key: string, value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value;
  return JSON.stringify(left, sortedKeys) === JSON.stringify(right, sortedKeys);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const query = request.nextUrl.searchParams;
    const parsed = querySchema.safeParse(Object.fromEntries(query));
    if (!domainIdSchema.safeParse(id).success || !parsed.success ||
        query.getAll("siteId").length !== 1 || query.getAll("channelId").length !== 1) {
      return json({ error: "Invalid email domain status request" }, 400);
    }
    const { siteId, channelId } = parsed.data;
    await requireZavuSiteManager(request, siteId);

    const snapshot = await loadDomainConnections(siteId);
    const targets = snapshot.connections.filter((connection) => connection.id === channelId);
    if (targets.length === 0) return json({ error: "Email channel connection was not found" }, 404);
    if (targets.length !== 1) throw new DomainConnectionConflict();
    const target = targets[0];
    const storedId = target.metadata?.email_domain_id;
    const storedDomain = target.metadata?.domain;
    const domain = typeof storedDomain === "string" ? normalizeEmailDomain(storedDomain) : null;
    // Status reads may include established senders, but never accept a provider
    // ID that is not already bound to this exact site's unique email target.
    if (target.type !== "email" || storedId !== id || !domain) {
      throw new DomainConnectionConflict();
    }

    let emailDomain;
    try {
      const validated = emailDomainProviderSchema.safeParse(await getEmailDomain(id));
      if (!validated.success || validated.data.id !== storedId || validated.data.domain !== domain) {
        throw new Error("Invalid provider response");
      }
      emailDomain = { ...validated.data, domain };
    } catch {
      return json({ error: "Zavu could not confirm the email domain" }, 502);
    }

    if (target.metadata?.domain_status !== emailDomain.status ||
        !sameJson(target.metadata?.dns_records, emailDomain.dnsRecords)) {
      // Keep the persisted domain/id byte-for-byte; only status and DNS change.
      // The helper's CAS refuses stale writes after sender or state changes.
      await saveDomainFields(siteId, channelId, undefined, snapshot, {
        ...emailDomain, domain: storedDomain as string,
      });
    }
    return json({ success: true, domain: emailDomain });
  } catch (error: unknown) {
    if (error instanceof ZavuAccessError) {
      return json({ error: error.status === 401 ? "Unauthorized" : "Forbidden" }, error.status);
    }
    if (error instanceof DomainConnectionConflict) {
      return json({ error: "Email domain connection conflict" }, 409);
    }
    return json({ error: "Could not refresh the email domain configuration" }, 500);
  }
}