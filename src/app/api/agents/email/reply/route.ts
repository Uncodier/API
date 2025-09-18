import { NextRequest, NextResponse } from 'next/server';
import { ComprehensiveEmailFilterService } from '@/lib/services/email/ComprehensiveEmailFilterService';
import { EmailConfigService } from '@/lib/services/email/EmailConfigService';
import { EmailService } from '@/lib/services/email/EmailService';
import { EmailProcessingService } from '@/lib/services/email/EmailProcessingService';
import { EmailRoutingService } from '@/lib/services/email/EmailRoutingService';
import { CaseConverterService, getFlexibleProperty } from '@/lib/utils/case-converter';

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const req = await request.json();
  const normalized = CaseConverterService.normalizeRequestData(req, 'snake');
  const siteId = getFlexibleProperty(req, 'site_id') || normalized.site_id;
  const limit = getFlexibleProperty(req, 'limit') || normalized.limit || 10;

  const emailConfig = await EmailConfigService.getEmailConfig(siteId);

  // Validate that there are NO aliases configured for this route
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

  if (hasAliases) {
    return NextResponse.json({
      success: false,
      error: {
        code: 'ALIASES_CONFIG_PRESENT',
        message: 'This route is intended for non-alias agent replies. Aliases are configured; use /api/agents/email/aliasReply or disable aliases for this site.'
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
      console.log(`[REPLY] Skipping mailbox '${box}' due to error or absence`);
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
  console.log(`[REPLY] Combined fetch size INBOX=${inboxEmails.length} extra=${extraResults.length} total=${emails.length} (dedup skipped=${duplicatesSkipped})`);

  // En reply genérico permitimos no-alias para análisis del agente
  const { validEmails, emailToEnvelopeMap, summary } = await ComprehensiveEmailFilterService.comprehensiveEmailFilter(
    emails,
    siteId,
    emailConfig,
    { allowNonAliasForAgent: true }
  );

  const partition = await EmailRoutingService.partition(validEmails, emailConfig, siteId);
  // Para esta ruta usamos únicamente los del agente (leads y alias ya se manejan en sus rutas)
  const prioritized = [...partition.agent];

  const selectedIds = new Set<string>();
  for (const email of prioritized) {
    const id = (email?.id || email?.uid || email?.messageId || '').toString();
    if (!id || selectedIds.has(id)) continue;
    selectedIds.add(id);
    if (selectedIds.size >= limit) break;
  }
  const limited = validEmails.filter(e => selectedIds.has((e?.id || e?.uid || e?.messageId || '').toString()));

  const separationLimited = await EmailProcessingService.separateEmailsByDestination(limited, emailConfig, siteId);
  const { emailsToAgent, directResponseEmails } = separationLimited;

  // No guardamos directos aquí; esta ruta es de agente
  const emailsForResponse = [...emailsToAgent, ...directResponseEmails];
  const emailsToSave = EmailProcessingService.filterEmailsToSave(emailsForResponse);
  await EmailProcessingService.saveProcessedEmails(
    emailsToSave,
    validEmails,
    emailToEnvelopeMap,
    siteId
  );

  return NextResponse.json({
    success: true,
    data: {
      message: 'Agent reply flow processed',
      filterSummary: summary,
      emails: emailsForResponse
    }
  });
}


