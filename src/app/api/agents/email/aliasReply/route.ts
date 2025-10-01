import { NextRequest, NextResponse } from 'next/server';
import { ComprehensiveEmailFilterService } from '@/lib/services/email/ComprehensiveEmailFilterService';
import { EmailConfigService } from '@/lib/services/email/EmailConfigService';
import { EmailService } from '@/lib/services/email/EmailService';
import { EmailProcessingService } from '@/lib/services/email/EmailProcessingService';
import { EmailRoutingService } from '@/lib/services/email/EmailRoutingService';
import { CaseConverterService, getFlexibleProperty } from '@/lib/utils/case-converter';
import { SiteEmailGuardService } from '@/lib/services/email/SiteEmailGuardService';

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const req = await request.json();
  const normalized = CaseConverterService.normalizeRequestData(req, 'snake');
  const siteId = getFlexibleProperty(req, 'site_id') || normalized.site_id;
  const limit = getFlexibleProperty(req, 'limit') || normalized.limit || 10;

  const emailConfig = await EmailConfigService.getEmailConfig(siteId);

  // Validate that there IS at least one alias configured for this route
  const hasAliases = (() => {
    const aliases = (emailConfig as any)?.aliases;
    if (!aliases) return false;
    if (Array.isArray(aliases)) {
      return aliases.filter(a => typeof a === 'string' && a.trim().length > 0).length > 0;
    }
    if (typeof aliases === 'string') {
      return aliases.split(',').map(s => s.trim()).filter(Boolean).length > 0;
    }
    return false;
  })();

  if (!hasAliases) {
    return NextResponse.json({
      success: false,
      error: {
        code: 'ALIASES_REQUIRED',
        message: 'Aliases are not configured for this site. Use /api/agents/email/reply or configure aliases in settings.'
      }
    }, { status: 400 });
  }

  const endRange = new Date();
  const startRange = new Date(Date.now() - 24 * 60 * 60 * 1000);
  // Fetch from INBOX + All Mail/Important variants and merge (excluding Sent in extra mailboxes)
  const inboxEmails = await EmailService.fetchEmailsInRange(
    emailConfig,
    startRange.toISOString(),
    endRange.toISOString(),
    500
  );
  const extraMailboxes = [
    '[Gmail]/Todos',
    '[Gmail]/Importantes',
    '[Gmail]/Spam',
  ];
  const extraResults: any[] = [];
  for (const box of extraMailboxes) {
    try {
      const boxEmails = await EmailService.fetchEmailsInRangeFromMailbox(
        emailConfig,
        startRange.toISOString(),
        endRange.toISOString(),
        box,
        200
      );
      extraResults.push(...boxEmails);
    } catch (e) {
      console.log(`[ALIAS_REPLY] Skipping mailbox '${box}' due to error or absence`);
    }
  }
  const seenKeys = new Set<string>();
  let duplicatesSkipped = 0;
  const mergeKey = (e: any) => (
    e.messageId || `${(e.from||'').toString()}|${(e.to||'').toString()}|${e.subject || ''}|${e.receivedAt || e.date || ''}`
  ).toString();
  const emails = [...inboxEmails, ...extraResults].filter(e => {
    const key = mergeKey(e).toLowerCase();
    if (!key) return true;
    if (seenKeys.has(key)) { duplicatesSkipped++; return false; }
    seenKeys.add(key);
    return true;
  });
  console.log(`[ALIAS_REPLY] Combined fetch size INBOX=${inboxEmails.length} extra=${extraResults.length} total=${emails.length} (dedup skipped=${duplicatesSkipped})`);

  const { validEmails, emailToEnvelopeMap, summary } = await ComprehensiveEmailFilterService.comprehensiveEmailFilter(
    emails,
    siteId,
    emailConfig,
    { allowNonAliasForAgent: false }
  );

  // Guard: no procesar correos entrantes desde el mismo dominio/direcciones del sitio
  const siteUrlDomain = await SiteEmailGuardService.getSiteUrlDomain(siteId);
  const guardResult = SiteEmailGuardService.filterOutInboundFromSiteDomain(validEmails, emailConfig, { siteId, siteUrlDomain });
  if (guardResult.skipped > 0) {
    console.log(`[ALIAS_REPLY] Guard skipped ${guardResult.skipped} inbound emails from site domain/addresses`);
  }

  const partition = await EmailRoutingService.partition(guardResult.filtered, emailConfig, siteId);
  const prioritized = [...partition.alias];

  const selectedIds = new Set<string>();
  for (const email of prioritized) {
    const id = (email?.id || email?.uid || email?.messageId || '').toString();
    if (!id || selectedIds.has(id)) continue;
    selectedIds.add(id);
    if (selectedIds.size >= limit) break;
  }
  const limited = guardResult.filtered.filter(e => selectedIds.has((e?.id || e?.uid || e?.messageId || '').toString()));

  const separationLimited = await EmailProcessingService.separateEmailsByDestination(limited, emailConfig, siteId);
  const { directResponseEmails } = separationLimited;

  const emailsToSave = EmailProcessingService.filterEmailsToSave(directResponseEmails);
  await EmailProcessingService.saveProcessedEmails(
    emailsToSave,
    guardResult.filtered,
    emailToEnvelopeMap,
    siteId
  );

  return NextResponse.json({
    success: true,
    data: {
      message: 'Alias direct replies processed',
      filterSummary: summary,
      emails: directResponseEmails
    }
  });
}


