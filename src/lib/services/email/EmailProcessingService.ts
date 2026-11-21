/**
 * EmailProcessingService - Servicio para procesamiento y separación de emails
 * Maneja la separación entre emails de aliases, AI leads y agente
 */

import { supabaseAdmin } from '@/lib/database/supabase-client';
import { LEGACY_DEFAULT_AGENT_FILTER } from '@/lib/services/agents/legacy-default-filter';
import { cleanHtmlContent } from '@/lib/utils/html-content-cleaner';
import { EmailDuplicationService } from './EmailDuplicationService';
import { SentEmailDuplicationService } from './SentEmailDuplicationService';
import { saveProcessedEmails } from './save-processed-emails';

interface EmailSeparationResult {
  emailsToAliases: any[];
  emailsFromAILeads: any[];
  emailsToAgent: any[];
  directResponseEmails: any[];
}

export class EmailProcessingService {

  /**
   * Busca el agente de soporte para un sitio
   */
  static async findSupportAgent(siteId: string): Promise<string> {
    const { data, error } = await supabaseAdmin
      .from('agents')
      .select('id')
      .eq('site_id', siteId)
      .eq('role', 'Customer Support')
      .or(LEGACY_DEFAULT_AGENT_FILTER)
      .single();

    if (error || !data) {
      throw new Error(`No se encontró un agente de soporte para el sitio ${siteId}`);
    }

    return data.id;
  }

  /**
   * Normaliza aliases de email
   */
  static normalizeAliases(emailConfig: any): string[] {
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
    return normalizedAliases;
  }

  /**
   * Obtiene leads asignados a IA
   */
  static async getAILeads(validEmails: any[], siteId: string): Promise<Map<string, any>> {
    const extractAddress = (value: any): string => {
      const raw = (value || '').toString().toLowerCase().trim();
      const match = raw.match(/<([^>]+)>/);
      return (match ? match[1] : raw).trim();
    };
    const fromEmails = validEmails.map(email => {
      const fromAddr = extractAddress(email.from);
      const replyToAddr = extractAddress(email.replyTo || email['reply-to'] || email.headers?.['reply-to']);
      const effective = replyToAddr && replyToAddr.includes('@') && replyToAddr !== fromAddr ? replyToAddr : fromAddr;
      return effective;
    }).filter(email => email && email.includes('@'));
    
    let aiLeadsMap = new Map<string, any>();
    if (fromEmails.length > 0) {
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
        console.log(`[EMAIL_PROCESSING] ✅ ${aiLeadsMap.size} leads asignados a IA encontrados`);
      } catch (error) {
        console.warn(`[EMAIL_PROCESSING] ⚠️ Error obteniendo leads de IA:`, error);
      }
    }
    
    return aiLeadsMap;
  }

  /**
   * Separa emails por destino: alias vs IA leads vs agente
   */
  static async separateEmailsByDestination(
    validEmails: any[], 
    emailConfig: any, 
    siteId: string,
    userId?: string
  ): Promise<EmailSeparationResult> {
    console.log(`[EMAIL_PROCESSING] 🔀 Separando ${validEmails.length} emails por destino...`);
    
    // Obtener aliases normalizados
    const normalizedAliases = this.normalizeAliases(emailConfig);
    
    // Obtener leads asignados a IA
    const aiLeadsMap = await this.getAILeads(validEmails, siteId);
    
    const emailsToAliases: any[] = [];
    const emailsFromAILeads: any[] = [];
    const emailsToAgent: any[] = [];
    
    for (const email of validEmails) {
      const emailTo = (email.to || '').toLowerCase().trim();
      const emailFrom = (email.from || '').toLowerCase().trim();
      const replyToRaw = (email.replyTo || email['reply-to'] || email.headers?.['reply-to'] || '').toLowerCase().trim();
      const extract = (val: string) => {
        const m = val.match(/<([^>]+)>/);
        return (m ? m[1] : val).trim();
      };
      const fromEmailOnly = extract(emailFrom);
      const replyToOnly = extract(replyToRaw);
      const effectiveFrom = replyToOnly && replyToOnly.includes('@') && replyToOnly !== fromEmailOnly ? replyToOnly : fromEmailOnly;
      
      const isToAlias = normalizedAliases.includes(emailTo);
      const isFromAILead = effectiveFrom && aiLeadsMap.has(effectiveFrom);
      
      // PRIORIDAD: Lead IA tiene prioridad sobre alias (los leads se responden automáticamente)
      if (isFromAILead) {
        console.log(`[EMAIL_PROCESSING] 🤖 Email de LEAD IA detectado: ${effectiveFrom} → ${emailTo} (Lead ID: ${aiLeadsMap.get(effectiveFrom).id})`);
        emailsFromAILeads.push({...email, leadInfo: aiLeadsMap.get(effectiveFrom)});
      } else if (isToAlias) {
        console.log(`[EMAIL_PROCESSING] 📧 Email a ALIAS detectado: ${email.from} → ${emailTo}`);
        emailsToAliases.push(email);
      } else {
        emailsToAgent.push(email);
      }
    }
    
    console.log(`[EMAIL_PROCESSING] 📊 Separación completada:`);
    console.log(`[EMAIL_PROCESSING]   - Emails a aliases: ${emailsToAliases.length}`);
    console.log(`[EMAIL_PROCESSING]   - Emails de leads IA: ${emailsFromAILeads.length}`);
    console.log(`[EMAIL_PROCESSING]   - Emails al agente: ${emailsToAgent.length}`);
    
    // Procesar emails directos
    const directResponseEmails = this.processDirectEmails(emailsToAliases, emailsFromAILeads, siteId, userId);
    
    return {
      emailsToAliases,
      emailsFromAILeads,
      emailsToAgent,
      directResponseEmails
    };
  }

  /**
   * Procesa emails que requieren respuesta directa (aliases y AI leads)
   */
  static processDirectEmails(emailsToAliases: any[], emailsFromAILeads: any[], siteId: string, userId?: string): any[] {
    const directResponseEmails: any[] = [];
    
    // Procesar emails a aliases
    if (emailsToAliases.length > 0) {
      console.log(`[EMAIL_PROCESSING] 🚀 Procesando ${emailsToAliases.length} emails a aliases directamente...`);
      
      for (const email of emailsToAliases) {
        const extractAddress = (value: any): string => {
          const raw = (value || '').toString();
          const match = raw.match(/<([^>]+)>/);
          return (match ? match[1] : raw).trim();
        };
        const fromAddress = extractAddress(email.from);
        const replyToAddress = extractAddress(email.replyTo || email['reply-to'] || email.headers?.['reply-to']);
        const effectiveFrom = (replyToAddress && replyToAddress.includes('@') && replyToAddress !== fromAddress) ? replyToAddress : fromAddress;
        console.log(`[EMAIL_PROCESSING] 🔍 DEBUG EMAIL INDIVIDUAL:`);
        console.log(`[EMAIL_PROCESSING] 🔍   ID: ${email.id || email.messageId || email.uid}`);
        console.log(`[EMAIL_PROCESSING] 🔍   FROM: ${effectiveFrom} (raw-from: ${email.from || ''}${replyToAddress ? `, reply-to: ${replyToAddress}` : ''})`);
        console.log(`[EMAIL_PROCESSING] 🔍   SUBJECT: ${email.subject}`);
        console.log(`[EMAIL_PROCESSING] 🔍   DATE: ${email.date || email.received_date}`);
        console.log(`[EMAIL_PROCESSING] 🔍   BODY LENGTH: ${(email.body || '').length} chars`);
        
        let cleanBody = email.body || '';
        
        // Limpieza HTML comprehensiva
        cleanBody = cleanHtmlContent(cleanBody);
        
        console.log(`[EMAIL_PROCESSING] 🔍   CLEAN BODY LENGTH: ${cleanBody.length} chars`);
        
        const directEmail = {
          summary: `Correo recibido de ${effectiveFrom} en alias ${email.to}. Respuesta automática requerida.`,
          original_text: cleanBody,
          original_subject: email.subject || '',
          contact_info: {
            name: effectiveFrom ? effectiveFrom.split('@')[0] : '',
            email: effectiveFrom || '',
            phone: '',
            company: effectiveFrom ? effectiveFrom.split('@')[1] : ''
          },
          site_id: siteId,
          user_id: userId || '',
          lead_notification: "email",
          analysis_id: email.id || email.messageId || email.uid || Date.now().toString(),
          priority: "medium",
          intent: "support",
          potential_value: "medium",
          origin: "email",
          shouldRespond: true,
          isAlias: true
        };
        
        directResponseEmails.push(directEmail);
        console.log(`[EMAIL_PROCESSING] ✅ Email de alias procesado: ${effectiveFrom} → ${email.to}`);
      }
    }
    
    // Procesar emails de leads IA
    if (emailsFromAILeads.length > 0) {
      console.log(`[EMAIL_PROCESSING] 🤖 Procesando ${emailsFromAILeads.length} emails de leads IA directamente...`);
      
      for (const email of emailsFromAILeads) {
        let cleanBody = email.body || '';
        
        // Limpieza HTML comprehensiva
        cleanBody = cleanHtmlContent(cleanBody);
        
        const directEmail = {
          summary: `Respuesta a lead asignado a IA: ${email.leadInfo.name || 'Lead sin nombre'} (ID: ${email.leadInfo.id})`,
          original_text: cleanBody,
          original_subject: email.subject || '',
          contact_info: {
            name: email.leadInfo.name || (email.from ? email.from.split('@')[0] : ''),
            email: email.from || '',
            phone: '',
            company: email.from ? email.from.split('@')[1] : '',
            lead_id: email.leadInfo.id,
            lead_status: email.leadInfo.status
          },
          site_id: siteId,
          user_id: userId || '',
          lead_notification: "email",
          analysis_id: email.id || email.messageId || email.uid || Date.now().toString(),
          priority: "high", // AI leads tienen prioridad alta
          intent: "follow_up",
          potential_value: "high",
          origin: "email",
          shouldRespond: true,
          isAILead: true,
          leadInfo: email.leadInfo
        };
        
        directResponseEmails.push(directEmail);
        console.log(`[EMAIL_PROCESSING] ✅ Email de lead IA procesado: ${email.from} (Lead: ${email.leadInfo.name || email.leadInfo.id})`);
      }
    }
    
    return directResponseEmails;
  }

  /**
   * Valida si un email contiene tokens de instrucciones
   */
  static containsInstructionTokens(email: any): boolean {
    const tokenPatterns = [
      'email_id_from_context',
      'Original subject of the email',
      'Original email content/message as received',
      'Summary of the message and client inquiry',
      'name found in the email',
      'from email address',
      'phone found in the email',
      'company found in the email'
    ];
    
    const emailStr = JSON.stringify(email).toLowerCase();
    return tokenPatterns.some(pattern => emailStr.includes(pattern.toLowerCase()));
  }

  /**
   * Extrae emails válidos de los resultados del comando
   */
  static extractEmailsFromResults(executedCommand: any): any[] {
    const emailsForResponse: any[] = [];
    
    if (executedCommand && executedCommand.results && Array.isArray(executedCommand.results)) {
      console.log(`[EMAIL_PROCESSING] 🔄 Iterando sobre ${executedCommand.results.length} resultados...`);
      
      for (const result of executedCommand.results) {
        console.log(`[EMAIL_PROCESSING] 📧 Resultado encontrado:`, JSON.stringify(result, null, 2));
        if (result.email) {
          if (this.containsInstructionTokens(result.email)) {
            console.log(`[EMAIL_PROCESSING] 🚫 Email rechazado - contiene tokens de instrucciones`);
            continue;
          }
          
          console.log(`[EMAIL_PROCESSING] ✅ Email válido encontrado en results`);
          emailsForResponse.push(result.email);
        } else if (result.summary) {
          // Nueva estructura plana (sin anidación)
          if (this.containsInstructionTokens(result)) {
            console.log(`[EMAIL_PROCESSING] 🚫 Email rechazado - contiene tokens de instrucciones`);
            continue;
          }
          
          console.log(`[EMAIL_PROCESSING] ✅ Email válido encontrado en results (formato plano)`);
          emailsForResponse.push(result);
        } else {
          console.log(`[EMAIL_PROCESSING] ❌ Result no tiene propiedad email ni summary:`, Object.keys(result));
        }
      }
    }
    
    return emailsForResponse;
  }

  static saveProcessedEmails = saveProcessedEmails;

  /**
   * Filtra emails que realmente requieren respuesta
   */
  static filterEmailsToSave(emailsForResponse: any[]): any[] {
    return emailsForResponse.filter(emailObj => {
      // Emails directos (aliases y AI leads) siempre se responden
      if (emailObj.isAlias || emailObj.isAILead || (emailObj.email && (emailObj.email.isAlias || emailObj.email.isAILead))) {
        return true;
      }
      
      // Emails del agente: solo si shouldRespond es true
      if (emailObj.email && emailObj.email.shouldRespond === true) {
        return true;
      }
      
      // Si no tiene estructura de email anidada, verificar directamente
      if (emailObj.shouldRespond === true) {
        return true;
      }
      
      console.log(`[EMAIL_PROCESSING] 🚫 Email NO se guardará (no requiere respuesta):`, emailObj.email?.id || emailObj.id);
      return false;
    });
  }

  /**
   * Verifica si un email es duplicado usando la lógica robusta del sync
   */
  static async checkEmailDuplication(
    email: any,
    conversationId: string,
    leadId: string,
    siteId: string
  ): Promise<{ isDuplicate: boolean; reason?: string; existingMessageId?: string }> {
    try {
      const result = await EmailDuplicationService.checkEmailDuplication(email, conversationId, leadId, siteId);
      
      if (result.isDuplicate) {
        console.log(`[EMAIL_PROCESSING] 🚫 Email duplicado detectado: ${result.reason}`);
        return {
          isDuplicate: true,
          reason: result.reason,
          existingMessageId: result.existingMessageId
        };
      }
      
      return { isDuplicate: false };
    } catch (error) {
      console.error(`[EMAIL_PROCESSING] ❌ Error verificando duplicados:`, error);
      return { isDuplicate: false };
    }
  }

  /**
   * Calcula estadísticas de procesamiento
   */
  static calculateProcessingStats(emailsForResponse: any[]): {
    aliasEmailsCount: number;
    aiLeadEmailsCount: number;
    agentEmailsCount: number;
    hasAliasEmails: boolean;
    hasAILeadEmails: boolean;
    hasAgentEmails: boolean;
    hasDirectEmails: boolean;
    processingMessage: string;
  } {
    const aliasEmailsCount = emailsForResponse.filter(e => e.isAlias || (e.email && e.email.isAlias)).length;
    const aiLeadEmailsCount = emailsForResponse.filter(e => e.isAILead || (e.email && e.email.isAILead)).length;
    const agentEmailsCount = emailsForResponse.filter(e => !e.isAlias && !e.isAILead && (!e.email || (!e.email.isAlias && !e.email.isAILead))).length;
    const hasAliasEmails = aliasEmailsCount > 0;
    const hasAILeadEmails = aiLeadEmailsCount > 0;
    const hasAgentEmails = agentEmailsCount > 0;
    const hasDirectEmails = hasAliasEmails || hasAILeadEmails;
    
    let processingMessage = "Análisis de emails completado exitosamente";
    if (hasDirectEmails && hasAgentEmails) {
      const directParts = [];
      if (hasAliasEmails) directParts.push(`${aliasEmailsCount} alias directos`);
      if (hasAILeadEmails) directParts.push(`${aiLeadEmailsCount} AI leads directos`);
      processingMessage = `Emails procesados: ${directParts.join(' + ')} + ${agentEmailsCount} analizados por agente`;
    } else if (hasDirectEmails && !hasAgentEmails) {
      const directParts = [];
      if (hasAliasEmails) directParts.push(`${aliasEmailsCount} aliases`);
      if (hasAILeadEmails) directParts.push(`${aiLeadEmailsCount} AI leads`);
      processingMessage = `${directParts.join(' + ')} procesados directamente para respuesta`;
    } else if (!hasDirectEmails && hasAgentEmails) {
      processingMessage = `${agentEmailsCount} emails analizados por agente`;
    }
    
    return {
      aliasEmailsCount,
      aiLeadEmailsCount,
      agentEmailsCount,
      hasAliasEmails,
      hasAILeadEmails,
      hasAgentEmails,
      hasDirectEmails,
      processingMessage
    };
  }
}