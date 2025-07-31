/**
 * API de Email - Encargada de obtener y analizar emails
 * Route: POST /api/agents/email
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { EmailService } from '@/lib/services/email/EmailService';
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
  console.log(`[EMAIL_API] 🔍 Procesando ${emails.length} emails para filtrado`);
  
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
      
      // Fetch emails con retry automático para asegurar suficientes emails válidos
      console.log(`[EMAIL_API] 📥 Obteniendo emails con límite: ${limit}, desde: ${sinceDate || 'sin límite de fecha'}`);
      console.log(`[EMAIL_API] 🔍 DEBUG: PRE_FETCH - ANTES de EmailService.fetchEmails()`);
      
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
      
      // Loop de retry para asegurar emails suficientes
      while (fetchAttempt < MAX_FETCH_ATTEMPTS) {
        fetchAttempt++;
        
        // Calcular fecha para este intento
        if (!sinceDate && HOURS_PROGRESSIONS[fetchAttempt - 1]) {
          const hoursBack = HOURS_PROGRESSIONS[fetchAttempt - 1];
          finalSinceDate = new Date(Date.now() - hoursBack! * 60 * 60 * 1000).toISOString();
          console.log(`[EMAIL_API] 🔄 Intento ${fetchAttempt}: Ampliando búsqueda a ${hoursBack}h atrás (${finalSinceDate})`);
         } else {
          console.log(`[EMAIL_API] 🔄 Intento ${fetchAttempt}: Usando fecha especificada: ${finalSinceDate}`);
        }
        
        // Fetch emails para este intento
        allEmails = await EmailService.fetchEmails(emailConfig, limit, finalSinceDate);
        console.log(`[EMAIL_API] 📧 Intento ${fetchAttempt}: ${allEmails.length} emails obtenidos`);
        
        if (allEmails.length === 0) {
          console.log(`[EMAIL_API] ⚠️ Intento ${fetchAttempt}: No se encontraron emails. ${fetchAttempt < MAX_FETCH_ATTEMPTS ? 'Ampliando rango...' : 'Procediendo sin emails'}`);
          if (fetchAttempt >= MAX_FETCH_ATTEMPTS) break;
          continue;
        }
        
        // Aplicar filtro rápido para estimar emails válidos
        const quickValidEmails = allEmails.filter(email => {
          const emailFrom = (email.from || '').toLowerCase();
          const emailTo = (email.to || '').toLowerCase();
          
          // Filtros básicos rápidos
          if (emailFrom.includes('@uncodie.com') && !emailTo.includes('@uncodie.com')) {
            return false; // Email enviado
          }
          if (emailFrom === emailTo) {
            return false; // Self-sent
          }
          return true;
        });
        
        console.log(`[EMAIL_API] 🔍 Intento ${fetchAttempt}: ~${quickValidEmails.length} emails potencialmente válidos (mínimo: ${MIN_VALID_EMAILS})`);
        
        if (quickValidEmails.length >= MIN_VALID_EMAILS || fetchAttempt >= MAX_FETCH_ATTEMPTS) {
          console.log(`[EMAIL_API] ✅ Intento ${fetchAttempt}: ${quickValidEmails.length >= MIN_VALID_EMAILS ? 'Suficientes emails encontrados' : 'Máximo de intentos alcanzado'}. Procediendo con filtro completo.`);
          break;
        }
        
        console.log(`[EMAIL_API] 📈 Intento ${fetchAttempt}: Insuficientes emails válidos (${quickValidEmails.length}/${MIN_VALID_EMAILS}). ${fetchAttempt < MAX_FETCH_ATTEMPTS ? 'Ampliando búsqueda...' : ''}`);
      }
      
      console.log(`[EMAIL_API] 🔍 DEBUG: POST_FETCH - DESPUÉS de EmailService.fetchEmails() con ${fetchAttempt} intentos`);
      console.log(`[EMAIL_API] ✅ Emails obtenidos exitosamente: ${allEmails.length} emails (rango final: ${finalSinceDate})`);
      console.log(`[EMAIL_API] 🔍 DEBUG: PUNTO 1 - Emails fetched completamente`);
      
       // Aplicar filtro comprehensivo optimizado (ahora usa ComprehensiveEmailFilterService)
       console.log(`[EMAIL_API] 🚀 Iniciando filtro comprehensivo para ${allEmails.length} emails...`);
       
       let validEmails, summary, emailToEnvelopeMap;
       try {
         const result = await ComprehensiveEmailFilterService.comprehensiveEmailFilter(allEmails, siteId, emailConfig);
         validEmails = result.validEmails;
         summary = result.summary;
         emailToEnvelopeMap = result.emailToEnvelopeMap;
       } catch (error) {
         console.error(`[EMAIL_API] ❌ ERROR en ComprehensiveEmailFilterService:`, error);
         throw error;
       }
       
       console.log(`[EMAIL_API] ✅ Filtro completado: ${validEmails.length}/${allEmails.length} emails válidos`);
      
       // SEPARAR EMAILS usando EmailProcessingService
       console.log(`[EMAIL_API] 🔀 Separando emails por destino...`);
       const separationResult = await EmailProcessingService.separateEmailsByDestination(validEmails, emailConfig, siteId, userId);
       const { emailsToAliases, emailsFromAILeads, emailsToAgent, directResponseEmails } = separationResult;
       
       if (emailsToAgent.length === 0 && emailsToAliases.length === 0 && emailsFromAILeads.length === 0) {
         console.log(`[EMAIL_API] ⚠️ No se encontraron emails para procesar después de la separación`);
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
      
      // Si solo hay emails directos (aliases o AI leads), devolver directamente
      if (emailsToAgent.length === 0 && directResponseEmails.length > 0) {
        console.log(`[EMAIL_API] 🎯 Solo emails directos encontrados, devolviendo respuesta directa...`);
        
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
            emailCount: validEmails.length,
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
              retryWasSuccessful: validEmails.length >= MIN_VALID_EMAILS
            }
          }
        });
      }

      // Si no se proporciona agentId, buscar el agente de soporte
      console.log(`[EMAIL_API] 🔍 Determinando agente ID efectivo...`);
      console.log(`[EMAIL_API] 🔍 DEBUG: PUNTO 6 - Antes de findSupportAgent`);
      const effectiveAgentId = agentId || await findSupportAgent(siteId);
      console.log(`[EMAIL_API] ✅ Agente ID efectivo: ${effectiveAgentId}`);
      console.log(`[EMAIL_API] 🔍 DEBUG: PUNTO 7 - Agente ID obtenido`);
      
      // Create and submit command (solo para emails que van al agente)
      console.log(`[EMAIL_API] 🔧 Creando comando de análisis de emails para el agente...`);
      const command = createEmailCommand(effectiveAgentId, siteId, emailsToAgent, emailConfig, analysisType, leadId, teamMemberId, userId);
      
      console.log(`[EMAIL_API] 📤 Enviando comando al servicio...`);
      const internalCommandId = await CommandManagementService.submitCommand(command);
      console.log(`📝 Comando creado con ID interno: ${internalCommandId}`);
      
      // Intentar obtener el UUID de la base de datos inmediatamente después de crear el comando
      console.log(`[EMAIL_API] 🔍 DEBUG: PUNTO 13 - Antes de getCommandDbUuid`);
      let initialDbUuid = await getCommandDbUuid(internalCommandId);
      console.log(`[EMAIL_API] 🔍 DEBUG: PUNTO 14 - getCommandDbUuid completado`);
      if (initialDbUuid) {
        console.log(`📌 UUID de base de datos obtenido inicialmente: ${initialDbUuid}`);
      }
      
      // Esperar a que el comando se complete (igual que chat)
      console.log(`[EMAIL_API] ⏳ Esperando a que el comando se complete...`);
      console.log(`[EMAIL_API] 🔍 DEBUG: PUNTO 15 - Antes de waitForCommandCompletion`);
      const { command: executedCommand, dbUuid, completed } = await waitForCommandCompletion(internalCommandId);
      console.log(`[EMAIL_API] 🔍 DEBUG: PUNTO 16 - waitForCommandCompletion completado`);
      
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
      
      // Extraer los datos de email de los results usando EmailProcessingService
      console.log(`[EMAIL_API] 🔍 Diagnosticando comando ejecutado:`);
      console.log(`[EMAIL_API] executedCommand existe: ${!!executedCommand}`);
      console.log(`[EMAIL_API] executedCommand.results existe: ${!!(executedCommand && executedCommand.results)}`);
      console.log(`[EMAIL_API] executedCommand.results.length: ${executedCommand?.results?.length || 0}`);
      
      // Extraer emails del comando ejecutado
      const agentEmails = EmailProcessingService.extractEmailsFromResults(executedCommand);
      
      // Combinar emails del agente con emails directos
      const emailsForResponse = [...agentEmails, ...directResponseEmails];
      
      console.log(`[EMAIL_API] 📊 Total emails para respuesta: ${emailsForResponse.length}`);
       
       // Marcar emails como procesados usando EmailProcessingService
       const emailsToSave = EmailProcessingService.filterEmailsToSave(emailsForResponse);
       console.log(`[EMAIL_API] 💾 Emails a guardar en synced: ${emailsToSave.length}/${emailsForResponse.length}`);
       
       await EmailProcessingService.saveProcessedEmails(
         emailsToSave, 
         validEmails, 
         emailToEnvelopeMap, 
         siteId, 
         effectiveDbUuid || undefined, 
         internalCommandId, 
         effectiveAgentId
       );
      
      // Calcular estadísticas de procesamiento usando EmailProcessingService
      const stats = EmailProcessingService.calculateProcessingStats(emailsForResponse);
      
      return NextResponse.json({
        success: true,
        data: {
          commandId: effectiveDbUuid || internalCommandId,
          status: executedCommand?.status || 'completed',
          message: stats.processingMessage,
          emailCount: validEmails.length,
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
            retryWasSuccessful: validEmails.length >= MIN_VALID_EMAILS
          }
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

// Función de validación de email (ahora usa ValidationService)
function isValidEmail(email: string): boolean {
  return ValidationService.isValidEmail(email);
} 