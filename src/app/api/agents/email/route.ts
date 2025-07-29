/**
 * API de Email - Encargada de obtener y analizar emails
 * Route: POST /api/agents/email
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { EmailService } from '@/lib/services/email/EmailService';
import { EmailConfigService } from '@/lib/services/email/EmailConfigService';
import { EmailTextExtractorService } from '@/lib/services/email/EmailTextExtractorService';
import { EmailFilterService } from '@/lib/services/email/EmailFilterService';
import { SyncedObjectsService } from '@/lib/services/synced-objects/SyncedObjectsService';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { CaseConverterService, getFlexibleProperty } from '@/lib/utils/case-converter';

// Configuración de timeout para Vercel Pro
export const maxDuration = 300; // 5 minutos en segundos (máximo para plan Pro)

// Initialize processor and get command service
const processorInitializer = ProcessorInitializer.getInstance();
processorInitializer.initialize();
const commandService = processorInitializer.getCommandService();

// Create schemas for request validation
const EmailAgentRequestSchema = z.object({
  site_id: z.string().min(1, "Site ID is required"),
  limit: z.number().max(20).default(5).optional(),
  lead_id: z.string().optional(),
  agentId: z.string().optional(),
  user_id: z.string().optional(),
  team_member_id: z.string().optional(),
  analysis_type: z.string().optional(),
  since_date: z.string().optional().refine(
    (date) => !date || !isNaN(Date.parse(date)),
    "since_date debe ser una fecha válida en formato ISO"
  ),
});

// Error codes
const ERROR_CODES = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  EMAIL_CONFIG_NOT_FOUND: 'EMAIL_CONFIG_NOT_FOUND',
  EMAIL_FETCH_ERROR: 'EMAIL_FETCH_ERROR',
  SYSTEM_ERROR: 'SYSTEM_ERROR',
  AGENT_NOT_FOUND: 'AGENT_NOT_FOUND'
};

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * Obtiene configuraciones para los filtros de seguridad
 */
function getSecurityConfig() {
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
 * FILTRO COMPREHENSIVO - Combina TODAS las validaciones en UN SOLO recorrido
 * Incluye: feedback loops, leads asignados a IA, aliases, duplicados, y seguridad
 */
async function comprehensiveEmailFilter(
  emails: any[], 
  siteId: string, 
  emailConfig: any
): Promise<{
  validEmails: any[], 
  summary: {
    originalCount: number,
    feedbackLoopFiltered: number,
    aliasFiltered: number,
    duplicateFiltered: number,
    securityFiltered: number,
    finalCount: number,
    aiLeadsFound: number
  }
}> {
  console.log(`[EMAIL_API] 🔍 Aplicando filtro comprehensivo a ${emails.length} emails...`);
  
  // 1. Obtener configuraciones una sola vez
  const securityConfig = getSecurityConfig();
  
  // 2. Normalizar aliases una sola vez
  let normalizedAliases: string[] = [];
  if (emailConfig.aliases) {
    if (Array.isArray(emailConfig.aliases)) {
      normalizedAliases = emailConfig.aliases;
    } else {
      const aliasesStr = String(emailConfig.aliases);
      if (aliasesStr.trim().length > 0) {
        normalizedAliases = aliasesStr
          .split(',')
          .map((alias: string) => alias.trim())
          .filter((alias: string) => alias.length > 0);
      }
    }
  }
  
  // 3. Buscar leads asignados a IA una sola vez
  const emailAddresses = emails.map(email => {
    const fromEmail = (email.from || '').toLowerCase().trim();
    const emailMatch = fromEmail.match(/<([^>]+)>/);
    return emailMatch ? emailMatch[1] : fromEmail;
  }).filter(email => email && email.includes('@'));
  
  let aiLeadsMap = new Map<string, any>();
  if (emailAddresses.length > 0) {
    try {
      const { data: aiLeads, error } = await supabaseAdmin
        .from('leads')
        .select('id, email, name, assignee_id, status, created_at')
        .eq('site_id', siteId)
        .is('assignee_id', null)
        .in('email', emailAddresses);
      
      if (!error && aiLeads) {
        aiLeads.forEach(lead => {
          aiLeadsMap.set(lead.email.toLowerCase(), lead);
        });
      }
    } catch (error) {
      console.warn(`[EMAIL_API] ⚠️ Error buscando leads asignados a IA:`, error);
    }
  }
  
  // 4. Obtener emails ya procesados una sola vez
  let processedEmailIds = new Set<string>();
  try {
    const filterResult = await SyncedObjectsService.filterUnprocessedEmails(emails, siteId, 'email');
    if (filterResult.alreadyProcessed) {
      filterResult.alreadyProcessed.forEach((email: any) => {
        const emailId = email.id || email.messageId || email.uid;
        if (emailId) processedEmailIds.add(emailId);
      });
    }
  } catch (error) {
    console.warn(`[EMAIL_API] ⚠️ Error verificando emails procesados:`, error);
  }
  
  // 5. UN SOLO recorrido aplicando TODAS las validaciones
  const stats = {
    originalCount: emails.length,
    feedbackLoopFiltered: 0,
    aliasFiltered: 0,
    duplicateFiltered: 0,
    securityFiltered: 0,
    finalCount: 0,
    aiLeadsFound: aiLeadsMap.size
  };
  
  const validEmails = emails.filter(email => {
    const emailContent = (email.body || email.text || '').toLowerCase();
    const emailSubject = (email.subject || '').toLowerCase();
    const emailFrom = (email.from || '').toLowerCase();
    const emailTo = (email.to || '').toLowerCase().trim();
    const emailId = email.id || email.messageId || email.uid;
    
    // VALIDACIÓN 1: Feedback Loops
    const containsServerUrl = securityConfig.serverDomain && (
      emailContent.includes(securityConfig.serverDomain) || 
      emailSubject.includes(securityConfig.serverDomain) ||
      emailContent.includes(securityConfig.serverUrl.toLowerCase())
    );
    
    const isFromServerDomain = securityConfig.serverDomain && emailFrom.includes(securityConfig.serverDomain);
    
    const isFromNoReplyAddress = securityConfig.noReplyAddresses.some(noReplyAddr => {
      if (!noReplyAddr) return false;
      const normalizedAddr = noReplyAddr.toLowerCase();
      return emailFrom.includes(normalizedAddr);
    });
    
    const isAutomatedEmail = securityConfig.noReplyPatterns.some(pattern => 
      emailFrom.includes(pattern) || emailSubject.includes(pattern)
    ) || (emailSubject.includes('re:') && 
      (emailContent.includes('generated by') || 
       emailContent.includes('automated') ||
       emailContent.includes('do not reply')));
    
    const hasAutomatedHeaders = email.headers && (
      email.headers['auto-submitted'] ||
      email.headers['x-auto-response-suppress'] ||
      (email.headers['precedence'] && email.headers['precedence'].toLowerCase() === 'bulk')
    );
    
    if (containsServerUrl || isFromServerDomain || isFromNoReplyAddress || isAutomatedEmail || hasAutomatedHeaders) {
      stats.feedbackLoopFiltered++;
      console.log(`[EMAIL_API] 🚫 Email filtrado (feedback loop): ${email.from}`);
      return false;
    }
    
    // VALIDACIÓN 2: Duplicados (ya procesados)
    if (emailId && processedEmailIds.has(emailId)) {
      stats.duplicateFiltered++;
      console.log(`[EMAIL_API] 🚫 Email filtrado (duplicado): ${emailId}`);
      return false;
    }
    
    // VALIDACIÓN 3: Extraer email del remitente para verificar leads asignados a IA
    const fromEmailAddress = emailFrom.match(/<([^>]+)>/) ? emailFrom.match(/<([^>]+)>/)?.[1] : emailFrom;
    
    // VALIDACIÓN 4: Self-sent emails (FROM == TO)
    const fromEmailOnly = fromEmailAddress || emailFrom;
    const toEmailOnly = emailTo.match(/<([^>]+)>/) ? emailTo.match(/<([^>]+)>/)?.[1] : emailTo;
    
    if (fromEmailOnly && toEmailOnly && fromEmailOnly === toEmailOnly) {
      stats.aliasFiltered++;
      console.log(`[EMAIL_API] 🚫 Email filtrado (self-sent): ${fromEmailOnly}`);
      return false;
    }
    
    // VALIDACIÓN 5: Verificar si es lead asignado a IA (INCLUIR automáticamente)
    if (fromEmailAddress && aiLeadsMap.has(fromEmailAddress)) {
      const aiLead = aiLeadsMap.get(fromEmailAddress);
      console.log(`[EMAIL_API] 🤖 Email de lead asignado a IA (incluido automáticamente): ${aiLead.name}`);
      return true;
    }
    
    // VALIDACIÓN 6: Verificar aliases (si están configurados)
    if (normalizedAliases.length > 0) {
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
        return destinationFields.some(destinationField => {
          if (destinationField === normalizedAlias || destinationField.includes(normalizedAlias)) {
            return true;
          }
          
          // Verificar formato <email>
          const emailMatches = destinationField.match(/<([^>]+)>/g);
          if (emailMatches) {
            return emailMatches.some((match: string) => {
              const extractedEmail = match.replace(/[<>]/g, '').trim();
              return extractedEmail === normalizedAlias;
            });
          }
          
          // Verificar lista separada por comas
          if (destinationField.includes(',')) {
            const emailList = destinationField.split(',').map((e: string) => e.trim());
            return emailList.some((singleEmail: string) => {
              const cleanEmail = singleEmail.replace(/.*<([^>]+)>.*/, '$1').trim();
              return cleanEmail === normalizedAlias || singleEmail === normalizedAlias;
            });
          }
          
          return false;
        });
      });
      
      if (!isValidByAlias) {
        stats.aliasFiltered++;
        console.log(`[EMAIL_API] 🚫 Email filtrado (no coincide con aliases): ${email.from}`);
        return false;
      }
    }
    
    // VALIDACIÓN 7: Seguridad final con EmailFilterService
    try {
      const securityResult = EmailFilterService.filterValidEmails([email], securityConfig.noReplyAddresses);
      if (securityResult.filteredEmails.length > 0) {
        stats.securityFiltered++;
        console.log(`[EMAIL_API] 🚫 Email filtrado (seguridad): ${email.from}`);
        return false;
      }
    } catch (error) {
      console.warn(`[EMAIL_API] ⚠️ Error en validación de seguridad para email ${email.from}:`, error);
    }
    
    // Si llega aquí, el email pasa todas las validaciones
    console.log(`[EMAIL_API] ✅ Email válido: ${email.from}`);
    return true;
  });
  
  stats.finalCount = validEmails.length;
  
  console.log(`[EMAIL_API] 📊 Filtro comprehensivo completado:`);
  console.log(`[EMAIL_API] - Emails originales: ${stats.originalCount}`);
  console.log(`[EMAIL_API] - Filtrados por feedback loops: ${stats.feedbackLoopFiltered}`);
  console.log(`[EMAIL_API] - Filtrados por aliases: ${stats.aliasFiltered}`);
  console.log(`[EMAIL_API] - Filtrados por duplicados: ${stats.duplicateFiltered}`);
  console.log(`[EMAIL_API] - Filtrados por seguridad: ${stats.securityFiltered}`);
  console.log(`[EMAIL_API] - Leads asignados a IA encontrados: ${stats.aiLeadsFound}`);
  console.log(`[EMAIL_API] - Emails válidos finales: ${stats.finalCount}`);
  
  return {
    validEmails,
    summary: stats
  };
}

/**
 * Busca el agente de soporte para un sitio
 */
async function findSupportAgent(siteId: string): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from('agents')
    .select('id')
    .eq('site_id', siteId)
    .eq('role', 'Customer Support')
    .single();

  if (error || !data) {
    throw new Error(`No se encontró un agente de soporte para el sitio ${siteId}`);
  }

  return data.id;
}

// Función para obtener el UUID de la base de datos para un comando
async function getCommandDbUuid(internalId: string): Promise<string | null> {
  try {
    // Intentar obtener el comando
    const command = await commandService.getCommandById(internalId);
    
    // Verificar metadata
    if (command && command.metadata && command.metadata.dbUuid) {
      if (isValidUUID(command.metadata.dbUuid)) {
        console.log(`🔑 UUID encontrado en metadata: ${command.metadata.dbUuid}`);
        return command.metadata.dbUuid;
      }
    }
    
    // Buscar en el mapa de traducción interno del CommandService
    try {
      // @ts-ignore - Accediendo a propiedades internas
      const idMap = (commandService as any).idTranslationMap;
      if (idMap && idMap.get && idMap.get(internalId)) {
        const mappedId = idMap.get(internalId);
        if (isValidUUID(mappedId)) {
          console.log(`🔑 UUID encontrado en mapa interno: ${mappedId}`);
          return mappedId;
        }
      }
    } catch (err) {
      console.log('No se pudo acceder al mapa de traducción interno');
    }
    
    // Buscar en la base de datos directamente por algún campo que pueda relacionarse
    if (command) {
      const { data, error } = await supabaseAdmin
        .from('commands')
        .select('id')
        .eq('task', command.task)
        .eq('user_id', command.user_id)
        .eq('status', command.status)
        .order('created_at', { ascending: false })
        .limit(1);
      
      if (!error && data && data.length > 0) {
        console.log(`🔑 UUID encontrado en búsqueda directa: ${data[0].id}`);
        return data[0].id;
      }
    }
    
    return null;
  } catch (error) {
    console.error('Error al obtener UUID de base de datos:', error);
    return null;
  }
}

// Función para esperar a que un comando se complete (igual que chat)
async function waitForCommandCompletion(commandId: string, maxAttempts = 200, delayMs = 1000) {
  let executedCommand = null;
  let attempts = 0;
  let dbUuid: string | null = null;
  
  console.log(`⏳ Esperando a que se complete el comando ${commandId}...`);
  
  // Crear una promesa que se resuelve cuando el comando se completa o se agota el tiempo
  return new Promise<{command: any, dbUuid: string | null, completed: boolean}>((resolve) => {
    const checkInterval = setInterval(async () => {
      attempts++;
      
      try {
        executedCommand = await commandService.getCommandById(commandId);
        
        if (!executedCommand) {
          console.log(`⚠️ No se pudo encontrar el comando ${commandId}`);
          clearInterval(checkInterval);
          resolve({command: null, dbUuid: null, completed: false});
          return;
        }
        
        // Guardar el UUID de la base de datos si está disponible
        if (executedCommand.metadata && executedCommand.metadata.dbUuid) {
          dbUuid = executedCommand.metadata.dbUuid as string;
          console.log(`🔑 UUID de base de datos encontrado en metadata: ${dbUuid}`);
        }
        
        // Considerar comandos en estado 'failed' como completados si tienen resultados
        const hasResults = executedCommand.results && executedCommand.results.length > 0;
        const commandFinished = executedCommand.status === 'completed' || 
                               (executedCommand.status === 'failed' && hasResults);
                               
        if (commandFinished) {
          console.log(`✅ Comando ${commandId} terminado con estado: ${executedCommand.status}${hasResults ? ' (con resultados)' : ''}`);
          
          // Intentar obtener el UUID de la base de datos si aún no lo tenemos
          if (!dbUuid || !isValidUUID(dbUuid)) {
            dbUuid = await getCommandDbUuid(commandId);
            console.log(`🔍 UUID obtenido después de completar: ${dbUuid || 'No encontrado'}`);
          }
          
          clearInterval(checkInterval);
          // Consideramos un comando fallido como "completado" si tiene resultados
          const effectivelyCompleted = executedCommand.status === 'completed' || 
                                     (executedCommand.status === 'failed' && hasResults);
          resolve({command: executedCommand, dbUuid, completed: effectivelyCompleted});
          return;
        }
        
        console.log(`⏳ Comando ${commandId} aún en ejecución (estado: ${executedCommand.status}), intento ${attempts}/${maxAttempts}`);
        
        if (attempts >= maxAttempts) {
          console.log(`⏰ Tiempo de espera agotado para el comando ${commandId}`);
          
          // Último intento de obtener el UUID
          if (!dbUuid || !isValidUUID(dbUuid)) {
            dbUuid = await getCommandDbUuid(commandId);
            console.log(`🔍 UUID obtenido antes de timeout: ${dbUuid || 'No encontrado'}`);
          }
          
          clearInterval(checkInterval);
          // Verificar si, a pesar del timeout, hay resultados utilizables
          const usableResults = executedCommand.results && executedCommand.results.length > 0;
          resolve({command: executedCommand, dbUuid, completed: usableResults});
        }
      } catch (error) {
        console.error(`Error al verificar estado del comando ${commandId}:`, error);
        clearInterval(checkInterval);
        resolve({command: null, dbUuid: null, completed: false});
      }
    }, delayMs);
  });
}

// Create command object for email analysis (versión simplificada que funcionaba)
function createEmailCommand(agentId: string, siteId: string, emails: any[], emailConfig: any, analysisType?: string, leadId?: string, teamMemberId?: string, userId?: string) {
  const defaultUserId = '00000000-0000-0000-0000-000000000000';

  // Optimizar emails extrayendo solo el texto relevante
  console.log(`[EMAIL_API] 🔧 Optimizando ${emails.length} emails antes del análisis...`);
  const optimizedEmails = EmailTextExtractorService.extractMultipleEmailsText(emails, {
    maxTextLength: 1000, // Reducir aún más el límite de texto por email
    removeSignatures: true,
    removeQuotedText: true,
    removeHeaders: true,
    removeLegalDisclaimer: true
  });

  // Calcular estadísticas de optimización
  const totalOriginalLength = optimizedEmails.reduce((sum, email) => sum + email.originalLength, 0);
  const totalOptimizedLength = optimizedEmails.reduce((sum, email) => sum + email.textLength, 0);
  const compressionRatio = totalOriginalLength > 0 ? (totalOptimizedLength / totalOriginalLength) : 0;
  
  console.log(`[EMAIL_API] 📊 Optimización completada:`);
  console.log(`[EMAIL_API] - Texto original: ${totalOriginalLength} caracteres`);
  console.log(`[EMAIL_API] - Texto optimizado: ${totalOptimizedLength} caracteres`);
  console.log(`[EMAIL_API] - Ratio de compresión: ${(compressionRatio * 100).toFixed(1)}%`);
  console.log(`[EMAIL_API] - Ahorro de tokens: ~${Math.round((totalOriginalLength - totalOptimizedLength) / 4)} tokens`);

  // Crear versión ultra-optimizada con solo los datos esenciales para el contexto
  const essentialEmailData = optimizedEmails.map((email, index) => ({
    id: emails[index]?.id || emails[index]?.messageId || emails[index]?.uid || `temp_${Date.now()}_${index}`,
    subject: email.subject,
    from: email.from,
    to: email.to,
    content: email.extractedText, // Solo el texto optimizado, NO el original
    date: emails[index]?.date || emails[index]?.received_date || 'unknown'
  }));

  // Calcular estadísticas finales con los datos esenciales
  const finalDataSize = JSON.stringify(essentialEmailData).length;
  const originalDataSize = JSON.stringify(optimizedEmails).length;
  const finalCompressionRatio = originalDataSize > 0 ? (finalDataSize / originalDataSize) : 0;
  
  console.log(`[EMAIL_API] 🚀 Optimización final completada:`);
  console.log(`[EMAIL_API] - Datos optimizados completos: ${originalDataSize} caracteres`);
  console.log(`[EMAIL_API] - Datos esenciales finales: ${finalDataSize} caracteres`);
  console.log(`[EMAIL_API] - Compresión adicional: ${(finalCompressionRatio * 100).toFixed(1)}%`);
  console.log(`[EMAIL_API] - Ahorro total vs original: ~${Math.round((totalOriginalLength - finalDataSize) / 4)} tokens`);

  return CommandFactory.createCommand({
    task: 'reply to emails',
    userId: userId || teamMemberId || defaultUserId,
    agentId: agentId,
    site_id: siteId,
    description: 'Identify potential leads, commercial opportunities and clients inqueries to reply. Focus ONLY on emails from prospects showing genuine interest in our products/services. IGNORE: transactional emails, vendor outreach, spam, and cold sales pitches from other companies unless they demonstrate clear interest in becoming customers.',
    targets: [
      {
        email: {
          id: "email_id_from_context",
          original_subject: "Original subject of the email",
          original_text: "Original email content/message as received",
          summary: "Summary of the message and client inquiry",
          contact_info: {
            name: "name found in the email",
            email: "from email address",
            phone: "phone found in the email",
            company: "company found in the email"
          }
        }
      }
    ],
    tools: [],
    context: JSON.stringify({
      emails: essentialEmailData,
      email_count: emails.length,
      optimized_email_count: essentialEmailData.length,
      text_compression_stats: {
        original_chars: totalOriginalLength,
        final_chars: finalDataSize,
        compression_ratio: (finalDataSize / totalOriginalLength * 100).toFixed(1) + '%',
        tokens_saved: Math.round((totalOriginalLength - finalDataSize) / 4)
      },
      site_id: siteId,
      inbox_info: {
        email_address: emailConfig?.email_address || 'unknown',
        provider: emailConfig?.provider || 'unknown',
        display_name: emailConfig?.display_name || emailConfig?.email_address || 'Unknown Inbox',
        company_name: emailConfig?.company_name || 'Unknown Company',
        business_type: emailConfig?.business_type || 'Unknown Business Type',
        industry: emailConfig?.industry || 'Unknown Industry'
      },
      analysis_type: analysisType,
      lead_id: leadId,
      team_member_id: teamMemberId,
      special_instructions: 'Return an array with every important email. Analyze only the essential email data provided. Email content has been heavily optimized: signatures, quoted text, headers, and legal disclaimers removed. Text limited to 1000 chars per email. Focus on emails showing genuine commercial interest. IMPORTANT: If there is not at least 1 email that require a response or qualify as a potential lead, RETURN AN EMPTY ARRAY in the results. []. CRITICAL: Always include the "id" field from the email context in your response for each email you analyze. IMPORTANT: Also include the "original_text" field with the actual email content from the context for each email you process.'
    }),
    supervisor: [
      { agent_role: "email_specialist", status: "not_initialized" },
      { agent_role: "sales_manager", status: "not_initialized" },
      { agent_role: "customer_service_manager", status: "not_initialized" }
    ],
    model: "gpt-4.1",
    modelType: "openai"
  });
}

// Main POST endpoint to analyze emails (versión simplificada)
export async function POST(request: NextRequest) {
  try {
    // Get and validate request data
    const requestData = await request.json();
    console.log('[EMAIL_API] Request data received:', JSON.stringify(requestData, null, 2));
    
    // Normalizar datos del request para aceptar tanto camelCase como snake_case
    const normalizedData = CaseConverterService.normalizeRequestData(requestData, 'snake');
    console.log('[EMAIL_API] Normalized data:', JSON.stringify(normalizedData, null, 2));
    
    const validationResult = EmailAgentRequestSchema.safeParse(normalizedData);
    
    if (!validationResult.success) {
      console.error("[EMAIL_API] Validation error details:", JSON.stringify({
        error: validationResult.error.format(),
        issues: validationResult.error.issues,
      }, null, 2));
      
      return NextResponse.json(
        {
          success: false,
          error: {
            code: ERROR_CODES.INVALID_REQUEST,
            message: "Parámetros de solicitud inválidos",
            details: validationResult.error.format(),
          },
        },
        { status: 400 }
      );
    }
    
    console.log('[EMAIL_API] Validation successful, parsed data:', JSON.stringify(validationResult.data, null, 2));
    
    // Extraer parámetros usando getFlexibleProperty para máxima compatibilidad
    const siteId = getFlexibleProperty(requestData, 'site_id') || validationResult.data.site_id;
    const limit = getFlexibleProperty(requestData, 'limit') || validationResult.data.limit || 5;
    const leadId = getFlexibleProperty(requestData, 'lead_id') || validationResult.data.lead_id;
    const agentId = getFlexibleProperty(requestData, 'agentId') || getFlexibleProperty(requestData, 'agent_id') || validationResult.data.agentId;
    const teamMemberId = getFlexibleProperty(requestData, 'team_member_id') || validationResult.data.team_member_id;
    const analysisType = getFlexibleProperty(requestData, 'analysis_type') || validationResult.data.analysis_type;
    const userId = getFlexibleProperty(requestData, 'user_id') || validationResult.data.user_id;
    const sinceDate = getFlexibleProperty(requestData, 'since_date') || validationResult.data.since_date;
    
    console.log('[EMAIL_API] Extracted parameters:', {
      siteId, limit, leadId, agentId, teamMemberId, analysisType, userId, sinceDate
    });
    
    try {
      // Get email configuration
      console.log(`[EMAIL_API] 🔧 Obteniendo configuración de email para sitio: ${siteId}`);
      const emailConfig = await EmailConfigService.getEmailConfig(siteId);
      console.log(`[EMAIL_API] ✅ Configuración de email obtenida exitosamente`);
      
      // Fetch emails (ya optimizados con límite de 25KB en EmailService)
      console.log(`[EMAIL_API] 📥 Obteniendo emails con límite: ${limit}, desde: ${sinceDate || 'sin límite de fecha'}`);
      const allEmails = await EmailService.fetchEmails(emailConfig, limit, sinceDate);
      console.log(`[EMAIL_API] ✅ Emails obtenidos exitosamente: ${allEmails.length} emails`);
      
      // Aplicar SOLO filtro básico y eficiente (UN SOLO recorrido)
      const { validEmails, summary } = await comprehensiveEmailFilter(allEmails, siteId, emailConfig);
      
             if (validEmails.length === 0) {
         console.log(`[EMAIL_API] ⚠️ No se encontraron emails para analizar después del filtrado comprehensivo`);
         return NextResponse.json({
           success: true,
           data: {
             commandId: null,
             status: 'completed',
             message: "No se encontraron emails válidos para analizar",
             emailCount: 0,
             originalEmailCount: allEmails.length,
             analysisCount: 0,
             emails: [],
             filterSummary: summary,
             reason: allEmails.length === 0 ? 'No hay emails nuevos en el buzón' : 'Todos los emails fueron filtrados por validaciones de negocio'
           }
         });
       }

      // Si no se proporciona agentId, buscar el agente de soporte
      console.log(`[EMAIL_API] 🔍 Determinando agente ID efectivo...`);
      const effectiveAgentId = agentId || await findSupportAgent(siteId);
      console.log(`[EMAIL_API] ✅ Agente ID efectivo: ${effectiveAgentId}`);
      
      // Create and submit command
      console.log(`[EMAIL_API] 🔧 Creando comando de análisis de emails...`);
      const command = createEmailCommand(effectiveAgentId, siteId, validEmails, emailConfig, analysisType, leadId, teamMemberId, userId);
      
      console.log(`[EMAIL_API] 📤 Enviando comando al servicio...`);
      const internalCommandId = await commandService.submitCommand(command);
      
      console.log(`📝 Comando creado con ID interno: ${internalCommandId}`);
      
      // Intentar obtener el UUID de la base de datos inmediatamente después de crear el comando
      let initialDbUuid = await getCommandDbUuid(internalCommandId);
      if (initialDbUuid) {
        console.log(`📌 UUID de base de datos obtenido inicialmente: ${initialDbUuid}`);
      }
      
      // Esperar a que el comando se complete (igual que chat)
      console.log(`[EMAIL_API] ⏳ Esperando a que el comando se complete...`);
      const { command: executedCommand, dbUuid, completed } = await waitForCommandCompletion(internalCommandId);
      
      // Usar el UUID obtenido inicialmente si no tenemos uno válido después de la ejecución
      const effectiveDbUuid = (dbUuid && isValidUUID(dbUuid)) ? dbUuid : initialDbUuid;
      
      // Si no completado y no hay resultados, retornar error
      if (!completed) {
        console.warn(`⚠️ Comando ${internalCommandId} no completó exitosamente en el tiempo esperado`);
        
        if (!executedCommand || !executedCommand.results || executedCommand.results.length === 0) {
          // Solo fallar si realmente no hay resultados utilizables
          return NextResponse.json(
            { 
              success: false, 
              error: { 
                code: 'COMMAND_EXECUTION_FAILED', 
                message: 'El comando no completó exitosamente y no se generaron resultados válidos' 
              } 
            },
            { status: 500 }
          );
        } else {
          // Si hay resultados a pesar del estado, continuamos con advertencia
          console.log(`⚠️ Comando en estado ${executedCommand.status} pero tiene ${executedCommand.results.length} resultados, continuando`);
        }
      }
      
      // Extraer los datos de email de los results para incluir en la respuesta
      const emailsForResponse: any[] = [];
      
      console.log(`[EMAIL_API] 🔍 Diagnosticando comando ejecutado:`);
      console.log(`[EMAIL_API] executedCommand existe: ${!!executedCommand}`);
      console.log(`[EMAIL_API] executedCommand.results existe: ${!!(executedCommand && executedCommand.results)}`);
      console.log(`[EMAIL_API] executedCommand.results.length: ${executedCommand?.results?.length || 0}`);
      
      // Función para validar si un email contiene tokens de instrucciones
      const containsInstructionTokens = (email: any): boolean => {
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
      };

      // Extraer SOLO de results (que contienen los emails procesados por el agente)
      if (executedCommand && executedCommand.results && Array.isArray(executedCommand.results)) {
        console.log(`[EMAIL_API] 🔄 Iterando sobre ${executedCommand.results.length} resultados...`);
        
        for (const result of executedCommand.results) {
          console.log(`[EMAIL_API] 📧 Resultado encontrado:`, JSON.stringify(result, null, 2));
          if (result.email) {
            // Validar si el email contiene tokens de instrucciones
            if (containsInstructionTokens(result.email)) {
              console.log(`[EMAIL_API] 🚫 Email rechazado - contiene tokens de instrucciones`);
              continue; // Saltar este email
            }
            
            console.log(`[EMAIL_API] ✅ Email válido encontrado en results`);
            emailsForResponse.push(result.email);
          } else {
            console.log(`[EMAIL_API] ❌ Result no tiene propiedad email:`, Object.keys(result));
          }
        }
      } else {
        console.log(`[EMAIL_API] ❌ No se encontraron results válidos para procesar`);
      }
      
             console.log(`[EMAIL_API] 📊 Emails extraídos para respuesta: ${emailsForResponse.length}`);
       
       // Marcar emails como procesados para evitar duplicados en futuras ejecuciones
       const processedEmailIds = emailsForResponse.map(email => email.id).filter(Boolean);
       if (processedEmailIds.length > 0) {
         try {
           const markingPromises = processedEmailIds.map(async (emailId) => {
             try {
               return await SyncedObjectsService.markAsProcessed(emailId, siteId, {
                 command_id: effectiveDbUuid || internalCommandId,
                 analysis_timestamp: new Date().toISOString(),
                 agent_id: effectiveAgentId
               });
             } catch (error) {
               console.warn(`[EMAIL_API] ⚠️ Error marcando email ${emailId} como procesado:`, error);
               return false;
             }
           });
           
           await Promise.all(markingPromises);
           console.log(`[EMAIL_API] ✅ Marcados ${processedEmailIds.length} emails como procesados`);
         } catch (error) {
           console.warn(`[EMAIL_API] ⚠️ Error en marcado de emails:`, error);
         }
       }
       
       return NextResponse.json({
         success: true,
         data: {
           commandId: effectiveDbUuid || internalCommandId,
           status: executedCommand?.status || 'completed',
           message: "Análisis de emails completado exitosamente",
           emailCount: validEmails.length,
           originalEmailCount: allEmails.length,
           analysisCount: emailsForResponse.length,
           filterSummary: summary,
           emails: emailsForResponse
         }
       });
      
    } catch (error: unknown) {
      console.error(`[EMAIL_API] 💥 Error en el flujo principal:`, error);
      
      const isConfigError = error instanceof Error && (
        error.message.includes('settings') || 
        error.message.includes('token')
      );

      const isAgentError = error instanceof Error && 
        error.message.includes('agente de soporte');
        
      const errorCode = isConfigError ? ERROR_CODES.EMAIL_CONFIG_NOT_FOUND : 
                       isAgentError ? ERROR_CODES.AGENT_NOT_FOUND :
                       ERROR_CODES.EMAIL_FETCH_ERROR;
      
      const errorMessage = error instanceof Error ? error.message : "Error procesando emails";
      
      return NextResponse.json(
        {
          success: false,
          error: {
            code: errorCode,
            message: errorMessage,
          },
        },
        { status: isConfigError || isAgentError ? 404 : 500 }
      );
    }
  } catch (error: unknown) {
    return NextResponse.json({
      success: false,
      error: {
        code: ERROR_CODES.SYSTEM_ERROR,
        message: error instanceof Error ? error.message : "Error interno del sistema",
      }
    }, { status: 500 });
  }
}

// GET method for backward compatibility
export async function GET(request: NextRequest) {
  return NextResponse.json({
    success: true,
    data: {
      message: "This endpoint requires a POST request with email analysis parameters. Please refer to the documentation."
    }
  }, { status: 200 });
}

// Función de validación de email
function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
} 