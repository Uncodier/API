import { NextRequest, NextResponse } from 'next/server';
import { ComprehensiveEmailFilterService } from '@/lib/services/email/ComprehensiveEmailFilterService';
import { EmailConfigService } from '@/lib/services/email/EmailConfigService';
import { EmailService } from '@/lib/services/email/EmailService';
import { EmailProcessingService } from '@/lib/services/email/EmailProcessingService';
import { EmailRoutingService } from '@/lib/services/email/EmailRoutingService';
import { EmailSyncErrorService } from '@/lib/services/email/EmailSyncErrorService';
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
  
  let inboxEmails: any[] = [];
  try {
    inboxEmails = await EmailService.fetchEmailsInRange(
      emailConfig,
      startRange.toISOString(),
      endRange.toISOString(),
      500
    );
  } catch (error: unknown) {
    const totalDuration = Date.now() - startRange.getTime(); // Not exactly start time but for logging
    
    const errorMessage = error instanceof Error ? error.message : "Error procesando repuestas de email";
    const isAuthError = errorMessage.toLowerCase().includes('authentication') || 
                        errorMessage.toLowerCase().includes('credentials');

    if (isAuthError) {
      console.warn(`[REPLY] ⚠️ Fallo de autenticación IMAP detectado: ${errorMessage}`);
    } else {
      console.error(`[REPLY] Error en el flujo principal:`, error);
    }
    
    // Si la bandeja principal falla por auth, cortamos rápido
    if (isAuthError) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'EMAIL_FETCH_ERROR',
            message: errorMessage
          },
        },
        { status: 401 }
      );
    }
    // Si no es auth error, dejamos que el error se loggee como 500 abajo
  }
  
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
    } catch (e: unknown) {
      console.log(`[REPLY] Skipping mailbox '${box}' due to error or absence`);
      const errorMessage = e instanceof Error ? e.message : String(e);
      if (errorMessage.toLowerCase().includes('authentication') || errorMessage.toLowerCase().includes('credentials')) {
        console.warn(`[REPLY] ⚠️ Fallo de autenticación IMAP en '${box}': ${errorMessage}`);
      }
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

  // Guard: no responder correos que provengan del mismo dominio/direcciones del sitio
  const siteUrlDomain = await SiteEmailGuardService.getSiteUrlDomain(siteId);
  const guardResult = SiteEmailGuardService.filterOutInboundFromSiteDomain(validEmails, emailConfig, { siteId, siteUrlDomain });
  if (guardResult.skipped > 0) {
    console.log(`[REPLY] Guard skipped ${guardResult.skipped} inbound emails from site domain/addresses`);
  }

  const partition = await EmailRoutingService.partition(guardResult.filtered, emailConfig, siteId);
  // Para esta ruta usamos únicamente los del agente (leads y alias ya se manejan en sus rutas)
  const prioritized = [...partition.agent];

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

  // Solo guardamos los emails que van a respuesta directa (como aliasReply y leadsReply)
  // Los emailsToAgent no se marcan como procesados para evitar duplicados
  const emailsToSave = EmailProcessingService.filterEmailsToSave(directResponseEmails);
  await EmailProcessingService.saveProcessedEmails(
    emailsToSave,
    guardResult.filtered,
    emailToEnvelopeMap,
    siteId
  );

  await EmailSyncErrorService.clearEmailSyncError(siteId);

  return NextResponse.json({
    success: true,
    data: {
      message: 'Agent reply flow processed',
      filterSummary: summary,
      emails: directResponseEmails
    }
  });
}


