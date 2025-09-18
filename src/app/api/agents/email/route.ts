/**
 * API de Email - Encargada de obtener y analizar emails
 * Route: POST /api/agents/email
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { EmailService } from '@/lib/services/email/EmailService';
import { EmailSyncErrorService } from '@/lib/services/email/EmailSyncErrorService';
import { EmailConfigService } from '@/lib/services/email/EmailConfigService';
import { ComprehensiveEmailFilterService } from '@/lib/services/email/ComprehensiveEmailFilterService';
import { EmailProcessingService } from '@/lib/services/email/EmailProcessingService';
import { CommandManagementService } from '@/lib/services/email/CommandManagementService';
import { ValidationService } from '@/lib/services/email/ValidationService';
import { CaseConverterService, getFlexibleProperty } from '@/lib/utils/case-converter';

// Configuración de timeout para Vercel Pro
export const maxDuration = 300; // 5 minutos en segundos (máximo para plan Pro)

// Create schemas for request validation
const EmailAgentRequestSchema = z.object({
  site_id: z.string().min(1, "Site ID is required"),
  limit: z.number().max(100).default(5).optional(),
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

// Función para validar UUIDs (ahora usa ValidationService)
function isValidUUID(uuid: string): boolean {
  return ValidationService.isValidUUID(uuid);
}

// Configuraciones de seguridad ahora manejadas por ComprehensiveEmailFilterService

// Filtro comprehensivo ahora manejado por ComprehensiveEmailFilterService
// (función mantenida para compatibilidad)
export async function comprehensiveEmailFilter(
  emails: any[], 
  siteId: string, 
  emailConfig: any
) {
  // Delegar al nuevo servicio
  return await ComprehensiveEmailFilterService.comprehensiveEmailFilter(emails, siteId, emailConfig);
}

// Búsqueda de agente ahora manejada por EmailProcessingService
async function findSupportAgent(siteId: string): Promise<string> {
  return await EmailProcessingService.findSupportAgent(siteId);
}

// Función para obtener el UUID de la base de datos para un comando (ahora usa CommandManagementService)
async function getCommandDbUuid(internalId: string): Promise<string | null> {
  return await CommandManagementService.getCommandDbUuid(internalId);
}

// Función para esperar a que un comando se complete (ahora usa CommandManagementService)
async function waitForCommandCompletion(commandId: string, maxAttempts = 200, delayMs = 1000) {
  return await CommandManagementService.waitForCommandCompletion(commandId, maxAttempts, delayMs);
}

// Create command object for email analysis (ahora usa CommandManagementService)
function createEmailCommand(agentId: string, siteId: string, emails: any[], emailConfig: any, analysisType?: string, leadId?: string, teamMemberId?: string, userId?: string) {
  return CommandManagementService.createEmailCommand(agentId, siteId, emails, emailConfig, analysisType, leadId, teamMemberId, userId);
}

// Main POST endpoint to analyze emails (versión simplificada)
export async function POST(request: NextRequest) {
  const startTime = Date.now();
  
  try {
    console.warn('[EMAIL_API] DEPRECATION: /api/agents/email está deprecada. Usa /api/agents/email/leadsReply, /api/agents/email/aliasReply o /api/agents/email/reply.');
    const deprecationHeaders = new Headers({
      'x-deprecated-route': 'Use /api/agents/email/leadsReply, /api/agents/email/aliasReply, /api/agents/email/reply'
    });
    // Get and validate request data
    const requestData = await request.json();
    
    // Normalizar datos del request para aceptar tanto camelCase como snake_case
    const normalizedData = CaseConverterService.normalizeRequestData(requestData, 'snake');
    
    const validationResult = EmailAgentRequestSchema.safeParse(normalizedData);
    
    if (!validationResult.success) {
      console.error("[EMAIL_API] Validation error:", validationResult.error.format());
      
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
    
    // Extraer parámetros usando getFlexibleProperty para máxima compatibilidad
    const siteId = getFlexibleProperty(requestData, 'site_id') || validationResult.data.site_id;
    const limit = getFlexibleProperty(requestData, 'limit') || validationResult.data.limit || 5;
    const leadId = getFlexibleProperty(requestData, 'lead_id') || validationResult.data.lead_id;
    const agentId = getFlexibleProperty(requestData, 'agentId') || getFlexibleProperty(requestData, 'agent_id') || validationResult.data.agentId;
    const teamMemberId = getFlexibleProperty(requestData, 'team_member_id') || validationResult.data.team_member_id;
    const analysisType = getFlexibleProperty(requestData, 'analysis_type') || validationResult.data.analysis_type;
    const userId = getFlexibleProperty(requestData, 'user_id') || validationResult.data.user_id;
    const sinceDate = getFlexibleProperty(requestData, 'since_date') || validationResult.data.since_date;
    
    try {
      // Get email configuration
      const emailConfig = await EmailConfigService.getEmailConfig(siteId);
      
      // Fetch emails con retry automático para asegurar suficientes emails válidos
      // Configuración de retry para asegurar emails suficientes
      const MIN_VALID_EMAILS = 2; // Mínimo de emails válidos después del filtrado
      const MAX_FETCH_ATTEMPTS = 3;
      const HOURS_PROGRESSIONS = [
        sinceDate ? null : 24, // Si ya hay sinceDate, usarlo en el primer intento
        48,  // 2 días
        168  // 1 semana
      ];
      
      let allEmails: any[] = [];
      let finalSinceDate = sinceDate;
      let fetchAttempt = 0;
      
      // Loop de retry para asegurar emails suficientes (pero siempre usando últimas 24h)
      while (fetchAttempt < MAX_FETCH_ATTEMPTS) {
        fetchAttempt++;
        
        // Ignorar since_date y traer exactamente las últimas 24 horas [now-24h, now)
        const endRange = new Date();
        const startRange = new Date(Date.now() - 24 * 60 * 60 * 1000);
        finalSinceDate = startRange.toISOString();
        
        // Fetch emails para este intento usando rango fijo de 24h
        allEmails = await EmailService.fetchEmailsInRange(
          emailConfig,
          startRange.toISOString(),
          endRange.toISOString(),
          500
        );

        // Log ordenado de emails obtenidos (antes de filtros)
        if (allEmails && allEmails.length > 0) {
          try {
            console.log(`[EMAIL_FETCH] 🧾 Emails obtenidos (ordenados por fecha desc): ${allEmails.length}`);
            const previewList = allEmails.slice(0, 100);
            for (let i = 0; i < previewList.length; i++) {
              const e = previewList[i] || {} as any;
              const date = (e.date || '').toString();
              const from = (e.from || '').toString();
              const to = (e.to || '').toString();
              const subjectFull = (e.subject || '').toString();
              const subject = subjectFull.length > 120 ? subjectFull.substring(0, 120) + '…' : subjectFull;
              console.log(`[EMAIL_FETCH] ${String(i + 1).padStart(2, '0')}. ${date} | ${from} -> ${to} | ${subject}`);
            }
            if (allEmails.length > previewList.length) {
              console.log(`[EMAIL_FETCH] … (${allEmails.length - previewList.length} más)`);
            }
          } catch (logErr) {
            console.warn(`[EMAIL_FETCH] ⚠️ Error generando log de emails obtenidos:`, logErr);
          }
        }
        
        if (allEmails.length === 0) {
          if (fetchAttempt >= MAX_FETCH_ATTEMPTS) break;
          continue;
        }
        
        // Aplicar filtro rápido para estimar emails válidos
        const quickValidEmails = allEmails.filter(email => {
          const emailFromRaw = (email.from || '').toLowerCase();
          const emailReplyToRaw = (email.replyTo || email['reply-to'] || email.headers?.['reply-to'] || '').toLowerCase();
          const emailTo = (email.to || '').toLowerCase();
          
          // Filtros básicos rápidos
          const fromEmailAddress = emailFromRaw.match(/<([^>]+)>/) ? emailFromRaw.match(/<([^>]+)>/)?.[1] : emailFromRaw;
          const replyToEmailAddress = emailReplyToRaw.match(/<([^>]+)>/) ? emailReplyToRaw.match(/<([^>]+)>/)?.[1] : emailReplyToRaw;
          const effectiveFromOnly = (replyToEmailAddress && replyToEmailAddress.includes('@')) && replyToEmailAddress !== fromEmailAddress
            ? replyToEmailAddress
            : (fromEmailAddress || emailFromRaw);

          if (effectiveFromOnly.includes('@uncodie.com') && !emailTo.includes('@uncodie.com')) {
            return false; // Email enviado
          }
          if (effectiveFromOnly === emailTo) {
            return false; // Self-sent
          }
          return true;
        });
        
        if (quickValidEmails.length >= MIN_VALID_EMAILS || fetchAttempt >= MAX_FETCH_ATTEMPTS) {
          break;
        }
      }
      
      // Aplicar filtro comprehensivo optimizado (ahora usa ComprehensiveEmailFilterService)
      let validEmails, summary, emailToEnvelopeMap;
      try {
        const result = await ComprehensiveEmailFilterService.comprehensiveEmailFilter(allEmails, siteId, emailConfig);
        validEmails = result.validEmails;
        summary = result.summary;
        emailToEnvelopeMap = result.emailToEnvelopeMap;
      } catch (error) {
        console.error(`[EMAIL_API] Error en ComprehensiveEmailFilterService:`, error);
        throw error;
      }

      // Priorizar y limitar por cantidad de mensajes a responder: leads IA → alias → agente
      const preliminarySeparation = await EmailProcessingService.separateEmailsByDestination(validEmails, emailConfig, siteId, userId);
      // Solo priorizamos correos con respuesta directa (leads IA y alias).
      // Emails para agente NO se seleccionan en este endpoint para evitar respuestas a contactos no calificados.
      const prioritized = [
        ...preliminarySeparation.emailsFromAILeads,
        ...preliminarySeparation.emailsToAliases
      ];
      const selectedIds = new Set<string>();
      for (const email of prioritized) {
        const id = (email?.id || email?.uid || email?.messageId || '').toString();
        if (!id || selectedIds.has(id)) continue;
        selectedIds.add(id);
        if (selectedIds.size >= limit) break;
      }
      // Subconjunto limitado por ID (no dependemos de envelope_id para seleccionar)
      const limitedValidEmails = validEmails.filter(e => selectedIds.has((e?.id || e?.uid || e?.messageId || '').toString()));
      
      // SEPARAR EMAILS (sobre el subconjunto limitado) usando EmailProcessingService
      const separationResult = await EmailProcessingService.separateEmailsByDestination(limitedValidEmails, emailConfig, siteId, userId);
      const { emailsToAliases, emailsFromAILeads, emailsToAgent, directResponseEmails } = separationResult;
      
      if (emailsToAgent.length === 0 && emailsToAliases.length === 0 && emailsFromAILeads.length === 0) {
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
        }, { headers: deprecationHeaders });
      }
      
      // Si solo hay emails directos (aliases o AI leads), devolver directamente
      if (emailsToAgent.length === 0 && directResponseEmails.length > 0) {
        // Guardar emails directos usando EmailProcessingService
        const emailsToSave = EmailProcessingService.filterEmailsToSave(directResponseEmails);
        await EmailProcessingService.saveProcessedEmails(
          emailsToSave, 
          validEmails, 
          emailToEnvelopeMap, 
          siteId
        );
        
        const stats = EmailProcessingService.calculateProcessingStats(directResponseEmails);
        
        return NextResponse.json({
          success: true,
          data: {
            commandId: null,
            status: 'completed',
            message: stats.processingMessage,
            emailCount: limitedValidEmails.length,
            originalEmailCount: allEmails.length,
            analysisCount: directResponseEmails.length,
            processingBreakdown: {
              aliasEmails: stats.aliasEmailsCount,
              aiLeadEmails: stats.aiLeadEmailsCount,
              agentEmails: 0,
              totalProcessed: directResponseEmails.length
            },
            filterSummary: summary,
            emails: directResponseEmails,
            processingType: 'direct_only',
            retryInfo: {
              fetchAttempts: fetchAttempt,
              maxAttempts: MAX_FETCH_ATTEMPTS,
              finalSinceDate: finalSinceDate,
              minValidEmailsRequired: MIN_VALID_EMAILS,
              retryWasSuccessful: limitedValidEmails.length >= MIN_VALID_EMAILS
            }
          }
        }, { headers: deprecationHeaders });
      }

      // Si no se proporciona agentId, buscar el agente de soporte
      const effectiveAgentId = agentId || await findSupportAgent(siteId);
      
      // Create and submit command (solo para emails que van al agente)
      const command = createEmailCommand(effectiveAgentId, siteId, emailsToAgent, emailConfig, analysisType, leadId, teamMemberId, userId);
      
      const internalCommandId = await CommandManagementService.submitCommand(command);
      
      // Intentar obtener el UUID de la base de datos inmediatamente después de crear el comando
      let initialDbUuid = await getCommandDbUuid(internalCommandId);
      
      // Esperar a que el comando se complete (igual que chat)
      const { command: executedCommand, dbUuid, completed } = await waitForCommandCompletion(internalCommandId);
      
      // Usar el UUID obtenido inicialmente si no tenemos uno válido después de la ejecución
      const effectiveDbUuid = (dbUuid && isValidUUID(dbUuid)) ? dbUuid : initialDbUuid;
      
      // Si no completado y no hay resultados, retornar error
      if (!completed) {
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
        }
      }
      
      // Extraer los datos de email de los results usando EmailProcessingService
      // Extraer emails del comando ejecutado
      const agentEmails = EmailProcessingService.extractEmailsFromResults(executedCommand);
      
      // Combinar para métricas, pero guardamos en dos pasos para evitar doble inserción
      const emailsForResponse = [...agentEmails, ...directResponseEmails];

      // 1) Guardar SOLO los emails del agente ahora
      const agentEmailsToSave = EmailProcessingService.filterEmailsToSave(agentEmails);
      await EmailProcessingService.saveProcessedEmails(
        agentEmailsToSave, 
        validEmails, 
        emailToEnvelopeMap, 
        siteId, 
        effectiveDbUuid || undefined, 
        internalCommandId, 
        effectiveAgentId
      );

      // Ensure synced_objects for all direct replies right before responding
      const ensureDirect = EmailProcessingService.filterEmailsToSave(directResponseEmails);
      if (ensureDirect.length > 0) {
        await EmailProcessingService.saveProcessedEmails(
          ensureDirect,
          validEmails,
          emailToEnvelopeMap,
          siteId,
          effectiveDbUuid || undefined,
          internalCommandId,
          effectiveAgentId
        );
      }
      
      // Calcular estadísticas de procesamiento usando EmailProcessingService
      const stats = EmailProcessingService.calculateProcessingStats(emailsForResponse);
      
      const totalDuration = Date.now() - startTime;
      
      return NextResponse.json({
        success: true,
        data: {
          commandId: effectiveDbUuid || internalCommandId,
          status: executedCommand?.status || 'completed',
          message: stats.processingMessage,
          emailCount: limitedValidEmails.length,
          originalEmailCount: allEmails.length,
          analysisCount: emailsForResponse.length,
          processingBreakdown: {
            aliasEmails: stats.aliasEmailsCount,
            aiLeadEmails: stats.aiLeadEmailsCount,
            agentEmails: stats.agentEmailsCount,
            totalProcessed: emailsForResponse.length
          },
          filterSummary: summary,
          emails: emailsForResponse,
          processingType: stats.hasDirectEmails && stats.hasAgentEmails ? 'mixed' : 
                         stats.hasDirectEmails ? 'direct_only' : 'agent_only',
          retryInfo: {
            fetchAttempts: fetchAttempt,
            maxAttempts: MAX_FETCH_ATTEMPTS,
            finalSinceDate: finalSinceDate,
            minValidEmailsRequired: MIN_VALID_EMAILS,
            retryWasSuccessful: limitedValidEmails.length >= MIN_VALID_EMAILS
          },
          performance: {
            totalDuration: totalDuration,
            fetchAttempts: fetchAttempt
          }
        }
      }, { headers: deprecationHeaders });
      
    } catch (error: unknown) {
      const totalDuration = Date.now() - startTime;
      console.error(`[EMAIL_API] Error en el flujo principal después de ${totalDuration}ms:`, error);
      
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

      // Trigger failure handler here (single source) with idempotency in service
      const errorType = error instanceof Error ? EmailSyncErrorService.determineErrorType(error) : 'fetch';
      if (EmailSyncErrorService.shouldHandleAsFailure(errorType)) {
        try {
          await EmailSyncErrorService.handleEmailSyncFailure({
            siteId,
            errorMessage,
            errorType,
            errorCode
          });
        } catch (failureHandlingError) {
          console.error(`[EMAIL_API] ❌ Error handling email failure:`, failureHandlingError);
        }
      }
      
      return NextResponse.json(
        {
          success: false,
          error: {
            code: errorCode,
            message: errorMessage,
            duration: totalDuration
          },
        },
        { status: isConfigError || isAgentError ? 404 : 500 }
      );
    }
  } catch (error: unknown) {
    const totalDuration = Date.now() - startTime;
    console.error(`[EMAIL_API] Error crítico después de ${totalDuration}ms:`, error);
    
    return NextResponse.json({
      success: false,
      error: {
        code: ERROR_CODES.SYSTEM_ERROR,
        message: error instanceof Error ? error.message : "Error interno del sistema",
        duration: totalDuration
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

// Función de validación de email (ahora usa ValidationService)
function isValidEmail(email: string): boolean {
  return ValidationService.isValidEmail(email);
} 