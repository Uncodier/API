/**
 * ComprehensiveEmailFilterService - Servicio para filtrado comprehensivo de emails
 * Integra todos los filtros en un solo servicio optimizado
 */

import { supabaseAdmin } from '@/lib/database/supabase-client';
import { SentEmailDuplicationService } from './SentEmailDuplicationService';
import { ReceivedEmailDuplicationService } from './ReceivedEmailDuplicationService';
import { EmailFilterService } from './EmailFilterService';

interface FilterSummary {
  originalCount: number;
  feedbackLoopFiltered: number;
  selfSentFiltered: number;
  aliasFiltered: number;
  duplicateFiltered: number;
  securityFiltered: number;
  finalCount: number;
  aiLeadsFound: number;
}

interface FilterResult {
  validEmails: any[];
  emailToEnvelopeMap: Map<any, string>;
  summary: FilterSummary;
}

interface SecurityConfig {
  serverUrl: string;
  serverDomain: string | null;
  noReplyAddresses: string[];
  noReplyPatterns: string[];
}

export class ComprehensiveEmailFilterService {
  
  /**
   * Obtiene configuraciones para los filtros de seguridad
   */
  private static getSecurityConfig(): SecurityConfig {
    const serverUrl = process.env.NEXT_PUBLIC_ORIGIN || 
                     process.env.VERCEL_URL || 
                     process.env.NEXT_PUBLIC_APP_URL || 
                     'http://localhost:3000';
    
    const serverDomain = (() => {
      try {
        const urlObj = new URL(serverUrl.startsWith('http') ? serverUrl : `https://${serverUrl}`);
        return urlObj.hostname.toLowerCase();
      } catch {
        return null;
      }
    })();

    const noReplyAddresses = [
      process.env.EMAIL_FROM,
      process.env.SENDGRID_FROM_EMAIL,
      process.env.NO_REPLY_EMAILS,
      'no-reply@uncodie.com',
      'noreply@uncodie.com'
    ].filter(Boolean).flatMap(addr => 
      addr && typeof addr === 'string' ? 
        (addr.includes(',') ? addr.split(',').map(a => a.trim()) : [addr]) : []
    );

    return {
      serverUrl: serverUrl.startsWith('http') ? serverUrl : `https://${serverUrl}`,
      serverDomain,
      noReplyAddresses: Array.from(new Set(noReplyAddresses)),
      noReplyPatterns: [
        'noreply', 'no-reply', 'donotreply', 'do-not-reply',
        'mailer-daemon', 'postmaster@', 'automated@', 'system@', 'daemon@'
      ]
    };
  }

  /**
   * Normaliza aliases de email
   */
  private static normalizeAliases(emailConfig: any): string[] {
    let normalizedAliases: string[] = [];
    if (emailConfig.aliases) {
      if (Array.isArray(emailConfig.aliases)) {
        normalizedAliases = emailConfig.aliases
          .map((alias: string) => alias.toLowerCase().trim())
          .filter((alias: string) => alias.length > 0);
      } else {
        const aliasesStr = String(emailConfig.aliases);
        if (aliasesStr.trim().length > 0) {
          normalizedAliases = aliasesStr
            .split(',')
            .map((alias: string) => alias.toLowerCase().trim())
            .filter((alias: string) => alias.length > 0);
        }
      }
    }
    
    console.log(`[COMPREHENSIVE_FILTER] ✅ ${normalizedAliases.length} aliases configurados: [${normalizedAliases.join(', ')}]`);
    return normalizedAliases;
  }

  /**
   * Genera envelope IDs para emails RECIBIDOS usando el nuevo servicio especializado
   */
  private static generateEnvelopeIds(emails: any[]): Map<any, string> {
    console.log(`[COMPREHENSIVE_FILTER] 🔧 Generando envelope IDs para ${emails.length} emails RECIBIDOS...`);
    const emailToEnvelopeMap = new Map<any, string>();
    
    for (const email of emails) {
      try {
        // Usar el nuevo servicio especializado para emails RECIBIDOS
        const envelopeId = ReceivedEmailDuplicationService.generateReceivedEmailEnvelopeId(email);
        if (envelopeId) {
          emailToEnvelopeMap.set(email, envelopeId);
        } else {
          console.warn(`[COMPREHENSIVE_FILTER] ⚠️ No se pudo generar envelope ID para: ${email.from} → ${email.to}`);
        }
      } catch (error) {
        console.error(`[COMPREHENSIVE_FILTER] ❌ ERROR generando envelope_id:`, error);
        throw error;
      }
    }
    
    console.log(`[COMPREHENSIVE_FILTER] 📊 ${emailToEnvelopeMap.size}/${emails.length} envelope IDs generados exitosamente`);
    return emailToEnvelopeMap;
  }

  /**
   * Aplica filtros básicos utilizando el EmailFilterService existente (con bypass para leads IA)
   */
  private static applyBasicFiltersWithAILeadsBypass(
    emails: any[],
    securityConfig: SecurityConfig,
    normalizedAliases: string[],
    aiLeadsMap: Map<string, any>
  ): { filteredEmails: any[], stats: Partial<FilterSummary> } {
    console.log(`[COMPREHENSIVE_FILTER] 🔧 Aplicando filtros básicos a ${emails.length} emails...`);
    
    const stats = {
      feedbackLoopFiltered: 0,
      aliasFiltered: 0,
      selfSentFiltered: 0,
      securityFiltered: 0
    };
    
    // Usar el EmailFilterService existente para delivery status y bounce
    const { validEmails: deliveryValidEmails } = EmailFilterService.filterValidEmails(emails, securityConfig.noReplyAddresses);
    stats.feedbackLoopFiltered = emails.length - deliveryValidEmails.length;
    
    // Aplicar filtros adicionales específicos
    const filteredEmails = deliveryValidEmails.filter(email => {
      const emailFrom = (email.from || '').toLowerCase();
      const emailTo = (email.to || '').toLowerCase().trim();
      
      // NUEVO FILTRO: Excluir emails enviados desde nuestro dominio hacia externos
      const fromEmailAddress = emailFrom.match(/<([^>]+)>/) ? emailFrom.match(/<([^>]+)>/)?.[1] : emailFrom;
      const fromEmailOnly = fromEmailAddress || emailFrom;
      const toEmailAddress = emailTo.match(/<([^>]+)>/) ? emailTo.match(/<([^>]+)>/)?.[1] : emailTo;
      const toEmailOnly = toEmailAddress || emailTo;
      
      // Si el email es FROM nuestro dominio HACIA una cuenta externa, es un email enviado que no debemos procesar
      if (fromEmailOnly.includes('@uncodie.com') && !toEmailOnly.includes('@uncodie.com')) {
        console.log(`[COMPREHENSIVE_FILTER] 🚫 Email enviado filtrado: ${fromEmailOnly} -> ${toEmailOnly} (email enviado desde nuestro dominio)`);
        stats.feedbackLoopFiltered++; // Usar esta categoría para este tipo de filtrado
        return false;
      }
      
      // VALIDACIÓN: Self-sent emails
      
      if (fromEmailOnly && toEmailOnly && fromEmailOnly === toEmailOnly) {
        stats.selfSentFiltered++;
        return false;
      }
      
      // VALIDACIÓN: Alias validation (SOLO si NO es un lead IA)
      if (normalizedAliases.length > 0) {
        // Verificar si es de un lead IA conocido - bypass de filtro de alias
        const fromEmailAddress = fromEmailOnly;
        const isFromAILead = aiLeadsMap.has(fromEmailAddress);
        
        if (isFromAILead) {
          console.log(`[COMPREHENSIVE_FILTER] 🤖 BYPASS: Email de lead IA (${fromEmailAddress}) → ${emailTo} - ignora validación de alias`);
          return true; // Bypass alias validation for AI leads
        }
        
        if (!this.isValidByAlias(email, emailTo, normalizedAliases)) {
          console.log(`[COMPREHENSIVE_FILTER] ❌ Email filtrado (no coincide con aliases): TO=${emailTo}`);
          stats.aliasFiltered++;
          return false;
        }
      }
      
      return true;
    });
    
    console.log(`[COMPREHENSIVE_FILTER] ✅ Filtros básicos completados: ${filteredEmails.length}/${emails.length} emails pasaron`);
    return { filteredEmails, stats };
  }

  /**
   * Verifica si un email es válido por aliases
   */
  private static isValidByAlias(email: any, emailTo: string, normalizedAliases: string[]): boolean {
    const emailFrom = (email.from || '').toLowerCase();
    
    const destinationFields = [
      emailTo,
      email.headers?.['delivered-to']?.toLowerCase?.().trim?.() || '',
      email.headers?.['x-original-to']?.toLowerCase?.().trim?.() || '',
      email.headers?.['x-envelope-to']?.toLowerCase?.().trim?.() || '',
      email.headers?.['x-rcpt-to']?.toLowerCase?.().trim?.() || '',
      email.headers?.['envelope-to']?.toLowerCase?.().trim?.() || ''
    ].filter(field => field && field.length > 0);

    const isValidByAlias = normalizedAliases.some(alias => {
      const normalizedAlias = alias.toLowerCase().trim();
      
      const matchResult = destinationFields.some(destinationField => {
        const normalizedField = destinationField.toLowerCase().trim();
        
        if (normalizedField === normalizedAlias || normalizedField.includes(normalizedAlias)) {
          return true;
        }
        
        // Verificar formato <email>
        const emailMatches = normalizedField.match(/<([^>]+)>/g);
        if (emailMatches) {
          const matchResult = emailMatches.some((match: string) => {
            const extractedEmail = match.replace(/[<>]/g, '').trim();
            return extractedEmail === normalizedAlias;
          });
          if (matchResult) return true;
        }
        
        // Verificar lista separada por comas
        if (normalizedField.includes(',')) {
          const emailList = normalizedField.split(',').map((e: string) => e.trim());
          const listMatchResult = emailList.some((singleEmail: string) => {
            const cleanEmail = singleEmail.replace(/.*<([^>]+)>.*/, '$1').trim();
            return cleanEmail === normalizedAlias || singleEmail === normalizedAlias;
          });
          if (listMatchResult) return true;
        }
        
        return false;
      });
      
      return matchResult;
    });
    
    return isValidByAlias;
  }

  /**
   * Obtiene leads asignados a IA
   */
  private static async getAILeads(fromEmails: string[], siteId: string): Promise<Map<string, any>> {
    const aiLeadsMap = new Map<string, any>();
    
    if (fromEmails.length === 0) return aiLeadsMap;
    
    try {
      const { data: aiLeads, error } = await supabaseAdmin
        .from('leads')
        .select('id, email, name, assignee_id, status, created_at')
        .eq('site_id', siteId)
        .is('assignee_id', null)
        .in('email', fromEmails);
      
      if (!error && aiLeads) {
        aiLeads.forEach(lead => {
          aiLeadsMap.set(lead.email.toLowerCase(), lead);
        });
      }
    } catch (error) {
      console.warn(`[COMPREHENSIVE_FILTER] ⚠️ Error buscando leads asignados a IA:`, error);
    }
    
    return aiLeadsMap;
  }

  /**
   * Obtiene emails ya procesados (solo con status 'processed' o 'replied')
   */
  private static async getProcessedEmails(envelopeIds: string[], siteId: string): Promise<Set<string>> {
    const processedEnvelopeIds = new Set<string>();
    
    if (envelopeIds.length === 0) return processedEnvelopeIds;
    
    try {
      const { data: existingObjects, error } = await supabaseAdmin
        .from('synced_objects')
        .select('external_id, status')
        .eq('site_id', siteId)
        .eq('object_type', 'email')
        .in('external_id', envelopeIds)
        .in('status', ['processed', 'replied']); // SOLO emails realmente procesados
      
      if (!error && existingObjects) {
        existingObjects.forEach(obj => processedEnvelopeIds.add(obj.external_id));
        console.log(`[COMPREHENSIVE_FILTER] 🔍 ${processedEnvelopeIds.size} emails ya procesados encontrados (status: processed/replied)`);
      }
    } catch (error) {
      console.warn(`[COMPREHENSIVE_FILTER] ⚠️ Error verificando emails procesados:`, error);
    }
    
    return processedEnvelopeIds;
  }

  /**
   * FILTRO COMPREHENSIVO - Función principal
   */
  static async comprehensiveEmailFilter(
    emails: any[], 
    siteId: string, 
    emailConfig: any
  ): Promise<FilterResult> {
    console.log(`[COMPREHENSIVE_FILTER] 🔍 Aplicando filtro comprehensivo a ${emails.length} emails...`);
    
    // 1. Obtener configuraciones
    const securityConfig = this.getSecurityConfig();
    
    // 2. Normalizar aliases
    const normalizedAliases = this.normalizeAliases(emailConfig);
    
    // 3. Generar envelope_ids
    const emailToEnvelopeMap = this.generateEnvelopeIds(emails);
    
    // 4. Obtener leads asignados a IA ANTES de filtros básicos
    const allFromEmails = emails.map(email => {
      const fromEmail = (email.from || '').toLowerCase().trim();
      const emailMatch = fromEmail.match(/<([^>]+)>/);
      return emailMatch ? emailMatch[1] : fromEmail;
    }).filter(email => email && email.includes('@'));
    
    const aiLeadsMap = await this.getAILeads(allFromEmails, siteId);
    console.log(`[COMPREHENSIVE_FILTER] 🤖 ${aiLeadsMap.size} leads IA encontrados para bypass de filtros`);
    
    // 5. Aplicar filtros básicos (con bypass para leads IA)
    const { filteredEmails: basicFilteredEmails, stats: basicStats } = 
      this.applyBasicFiltersWithAILeadsBypass(emails, securityConfig, normalizedAliases, aiLeadsMap);
    
    // 6. Verificar emails ya procesados
    const envelopeIds = basicFilteredEmails.map(email => emailToEnvelopeMap.get(email)).filter(Boolean);
    const processedEnvelopeIds = await this.getProcessedEmails(envelopeIds, siteId);
    
    // 7. Aplicar filtros finales
    const validEmails = basicFilteredEmails.filter(email => {
      const emailFrom = (email.from || '').toLowerCase();
      const emailTo = (email.to || '').toLowerCase();
      const fromEmailAddress = emailFrom.match(/<([^>]+)>/) ? emailFrom.match(/<([^>]+)>/)?.[1] : emailFrom;
      
      // Incluir automáticamente leads asignados a IA
      if (fromEmailAddress && aiLeadsMap.has(fromEmailAddress)) {
        console.log(`[COMPREHENSIVE_FILTER] 🤖 Lead IA incluido automáticamente: ${fromEmailAddress} → ${emailTo}`);
        return true;
      }
      
      // Filtrar duplicados
      const emailEnvelopeId = emailToEnvelopeMap.get(email);
      if (emailEnvelopeId && processedEnvelopeIds.has(emailEnvelopeId)) {
        console.log(`[COMPREHENSIVE_FILTER] 🚨 Email duplicado filtrado: ${emailFrom} → ${emailTo} (ID: ${emailEnvelopeId})`);
        basicStats.duplicateFiltered = (basicStats.duplicateFiltered || 0) + 1;
        return false;
      }
      
      return true;
    });
    
    const summary: FilterSummary = {
      originalCount: emails.length,
      feedbackLoopFiltered: basicStats.feedbackLoopFiltered || 0,
      selfSentFiltered: basicStats.selfSentFiltered || 0,
      aliasFiltered: basicStats.aliasFiltered || 0,
      duplicateFiltered: basicStats.duplicateFiltered || 0,
      securityFiltered: basicStats.securityFiltered || 0,
      finalCount: validEmails.length,
      aiLeadsFound: aiLeadsMap.size
    };
    
    console.log(`[COMPREHENSIVE_FILTER] 📊 Filtro comprehensivo completado:`, summary);
    
    return {
      validEmails,
      emailToEnvelopeMap,
      summary
    };
  }
}