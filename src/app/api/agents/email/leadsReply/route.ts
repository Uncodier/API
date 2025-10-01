import { NextRequest, NextResponse } from 'next/server';
import { ComprehensiveEmailFilterService } from '@/lib/services/email/ComprehensiveEmailFilterService';
import { EmailConfigService } from '@/lib/services/email/EmailConfigService';
import { EmailService } from '@/lib/services/email/EmailService';
import { EmailProcessingService } from '@/lib/services/email/EmailProcessingService';
import { EmailRoutingService } from '@/lib/services/email/EmailRoutingService';
import { CaseConverterService, getFlexibleProperty } from '@/lib/utils/case-converter';
import { SiteEmailGuardService } from '@/lib/services/email/SiteEmailGuardService';
import { supabaseAdmin } from '@/lib/database/supabase-client';

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const req = await request.json();
  const normalized = CaseConverterService.normalizeRequestData(req, 'snake');
  const siteId = getFlexibleProperty(req, 'site_id') || normalized.site_id;
  const limit = getFlexibleProperty(req, 'limit') || normalized.limit || 10;

  const emailConfig = await EmailConfigService.getEmailConfig(siteId);
  // Log full mailbox list for diagnosis
  try {
    const mailboxes = await EmailService.listAllMailboxes(emailConfig);
    console.log(`[LEADS_REPLY] Mailboxes available (${mailboxes.length}):`, mailboxes.map(m => ({ name: m.name, path: m.path, specialUse: m.specialUse, attributes: m.attributes })));
  } catch {}

  const endRange = new Date();
  const startRange = new Date(Date.now() - 24 * 60 * 60 * 1000);
  // Fetch from INBOX plus common Gmail tags that may hold messages not surfaced in INBOX
  const inboxEmails = await EmailService.fetchEmailsInRange(
    emailConfig,
    startRange.toISOString(),
    endRange.toISOString(),
    500
  );
  const extraMailboxes = [
    '[Gmail]/Important',
    '[Gmail]/All Mail',
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
      console.log(`[LEADS_REPLY] Skipping mailbox '${box}' due to error or absence`);
    }
  }
  // Merge by messageId or subject+date fallback to avoid duplicates
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
  console.log(`[LEADS_REPLY] Combined fetch size INBOX=${inboxEmails.length} extra=${extraResults.length} total=${emails.length} (dedup skipped=${duplicatesSkipped})`);
  try {
    const preview = emails.slice(0, 100);
    console.log(`[LEADS_REPLY] Preview of fetched emails (pre-filter): ${preview.length}`);
    preview.forEach((e, idx) => {
      const subj = (e.subject||'').toString();
      console.log(`[LEADS_REPLY] ${String(idx+1).padStart(2,'0')}. ${(e.date||'').toString()} | ${(e.from||'').toString()} -> ${(e.to||'').toString()} | ${subj.length>120?subj.substring(0,120)+'…':subj}`);
    });
    const targetAddr = 'sergio.prado@me.com';
    const anyTarget = [...inboxEmails, ...extraResults].some(e => ((e.from||'').toString().toLowerCase().includes(targetAddr) || (e.replyTo||'').toString().toLowerCase().includes(targetAddr)));
    console.log(`[LEADS_REPLY][SCAN] Target '${targetAddr}' present in raw fetched sets? ${anyTarget}`);
  } catch {}

  // Do NOT filter by alias for this route; we want to include non-alias emails
  // because we will respond to any sender that is an assigned lead in DB.
  const { validEmails, emailToEnvelopeMap, summary } = await ComprehensiveEmailFilterService.comprehensiveEmailFilter(
    emails,
    siteId,
    emailConfig,
    { allowNonAliasForAgent: true }
  );
  // Guard: no procesar correos entrantes que provienen del mismo dominio/direcciones del sitio
  const siteUrlDomain = await SiteEmailGuardService.getSiteUrlDomain(siteId);
  const guardResult = SiteEmailGuardService.filterOutInboundFromSiteDomain(validEmails, emailConfig, { siteId, siteUrlDomain });
  if (guardResult.skipped > 0) {
    console.log(`[LEADS_REPLY] Guard skipped ${guardResult.skipped} inbound emails from site domain/addresses`);
  }
  console.log(`[LEADS_REPLY] Received ${emails.length} emails, ${guardResult.filtered.length} after filters for site ${siteId}`);

  // Build a set of sender addresses and fetch ASSIGNED leads from DB
  const extractAddress = (value: any): string => {
    const raw = (value || '').toString().toLowerCase().trim();
    const match = raw.match(/<([^>]+)>/);
    return (match ? match[1] : raw).trim();
  };

  // Normalize aliases and domains to detect alias scenarios
  const normalizedAliases = EmailProcessingService.normalizeAliases(emailConfig);
  const aliasDomains = Array.from(new Set(
    normalizedAliases
      .map(a => (a.includes('@') ? a.split('@')[1] : ''))
      .filter(Boolean)
  ));

  const computeEffectiveFrom = (email: any): { effectiveFrom: string; reason: string } => {
    const fromAddr = extractAddress(email.from);
    const replyToAddr = extractAddress(email.replyTo || (email as any)['reply-to'] || email.headers?.['reply-to']);
    const toAddr = extractAddress(email.to);
    const fromDomain = (fromAddr.split('@')[1] || '').trim();

    const isToAlias = normalizedAliases.includes(toAddr);
    const isFromAlias = normalizedAliases.includes(fromAddr);
    const isFromOurAliasDomain = aliasDomains.includes(fromDomain);

    // Prefer reply-to when message targets an alias or from is an alias/our domain
    if (replyToAddr && replyToAddr.includes('@') && replyToAddr !== fromAddr && (isToAlias || isFromAlias || isFromOurAliasDomain)) {
      return { effectiveFrom: replyToAddr, reason: `reply-to-preferred (isToAlias=${isToAlias}, isFromAlias=${isFromAlias}, isFromOurAliasDomain=${isFromOurAliasDomain})` };
    }

    // Otherwise, fallback to reply-to if it's a different external address
    if (replyToAddr && replyToAddr.includes('@') && replyToAddr !== fromAddr) {
      return { effectiveFrom: replyToAddr, reason: 'reply-to-different' };
    }

    return { effectiveFrom: fromAddr, reason: 'from-used' };
  };

  const effectiveFromAddresses = guardResult.filtered.map(email => {
    const result = computeEffectiveFrom(email);
    console.log(`[LEADS_REPLY] effectiveFrom decision id=${(email?.id || email?.uid || email?.messageId || '').toString()} → ${result.effectiveFrom} (${result.reason})`);
    return result.effectiveFrom;
  }).filter(addr => addr && addr.includes('@')) as string[];
  console.log(`[LEADS_REPLY] Effective FROM candidates (${effectiveFromAddresses.length}):`, effectiveFromAddresses);

  let assignedLeadsMap = new Map<string, any>();
  if (effectiveFromAddresses.length > 0) {
    const uniqueAddresses = Array.from(new Set(effectiveFromAddresses));
    console.log(`[LEADS_REPLY] Unique addresses for DB lookup (${uniqueAddresses.length}):`, uniqueAddresses);
    const { data: assignedLeads, error } = await supabaseAdmin
      .from('leads')
      .select('id, email, name, assignee_id, status, created_at')
      .eq('site_id', siteId)
      .is('assignee_id', null)
      .in('email', uniqueAddresses);
    if (!error && assignedLeads) {
      console.log(`[LEADS_REPLY] DB returned ${assignedLeads.length} unassigned leads:`, assignedLeads.map(l => l.email));
      assignedLeads.forEach(lead => {
        if (lead?.email) assignedLeadsMap.set(String(lead.email).toLowerCase(), lead);
      });
    }
    if (error) {
      console.warn(`[LEADS_REPLY] ⚠️ Error fetching leads:`, error);
    }
  }

  // Targeted diagnostics for a specific address
  const targetDebugAddress = 'sergio.prado@me.com';
  console.log(`[LEADS_REPLY][DEBUG] Target '${targetDebugAddress}' present in candidates?`, effectiveFromAddresses.includes(targetDebugAddress));
  console.log(`[LEADS_REPLY][DEBUG] Target '${targetDebugAddress}' present in DB map?`, assignedLeadsMap.has(targetDebugAddress));

  // Per-email match diagnostics before filtering
  for (const email of guardResult.filtered) {
    const id = (email?.id || email?.uid || email?.messageId || '').toString();
    const rawFrom = (email.from || '').toString();
    const rawReply = (email.replyTo || (email as any)['reply-to'] || email.headers?.['reply-to'] || '').toString();
    const fromAddr = extractAddress(rawFrom);
    const replyToAddr = extractAddress(rawReply);
    const effectiveFrom = replyToAddr && replyToAddr.includes('@') && replyToAddr !== fromAddr ? replyToAddr : fromAddr;
    const matched = assignedLeadsMap.has(effectiveFrom);
    console.log(`[LEADS_REPLY] Match check id=${id} effectiveFrom=${effectiveFrom} matched=${matched}`);
    if (effectiveFrom === targetDebugAddress) {
      console.log(`[LEADS_REPLY][TARGET] Raw from='${rawFrom}' reply-to='${rawReply}' → effective='${effectiveFrom}' matched=${matched}`);
    }
  }

  // Keep only emails coming FROM unassigned (IA) leads (ignore alias filtering completely)
  const emailsFromAssignedLeads = guardResult.filtered
    .map(email => {
      const { effectiveFrom } = computeEffectiveFrom(email);
      const leadInfo = assignedLeadsMap.get(effectiveFrom);
      return leadInfo ? { ...email, leadInfo } : null;
    })
    .filter(Boolean) as any[];

  // Prioritize unique messages up to limit
  const selectedIds = new Set<string>();
  const prioritized: any[] = [];
  for (const email of emailsFromAssignedLeads) {
    const id = (email?.id || email?.uid || email?.messageId || '').toString();
    if (!id || selectedIds.has(id)) continue;
    selectedIds.add(id);
    prioritized.push(email);
    if (selectedIds.size >= limit) break;
  }

  // Convert to direct-response format using existing processor
  const directResponseEmails = EmailProcessingService.processDirectEmails([], prioritized, siteId);
  console.log(`[LEADS_REPLY] Direct responses prepared: ${directResponseEmails.length}`);

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
      message: 'IA leads direct replies processed',
      filterSummary: summary,
      emails: directResponseEmails
    }
  });
}


