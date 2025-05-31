/**
 * API de Email - Encargada de obtener y analizar emails
 * Route: POST /api/agents/email
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { EmailService } from '@/lib/services/email/EmailService';
import { EmailConfigService } from '@/lib/services/email/EmailConfigService';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { WorkflowService, ScheduleCustomerSupportParams, AnalysisData } from '@/lib/services/workflow-service';

// Initialize processor and get command service
const processorInitializer = ProcessorInitializer.getInstance();
processorInitializer.initialize();
const commandService = processorInitializer.getCommandService();

// Create schemas for request validation
const EmailAgentRequestSchema = z.object({
  site_id: z.string().min(1, "Site ID is required"),
  limit: z.number().default(10).optional(),
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

// Función para esperar a que un comando se complete
async function waitForCommandCompletion(commandId: string, maxAttempts = 60, delayMs = 1000) {
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

/**
 * Programa el customer support después de que se complete el análisis
 */
async function scheduleCustomerSupportAfterAnalysis(
  analysisArray: AnalysisData[], 
  siteId: string, 
  userId: string
): Promise<void> {
  try {
    if (analysisArray.length > 0) {
      console.log(`[EMAIL_API] Encontrados ${analysisArray.length} análisis, programando customer support...`);
      
      // Llamar al servicio de Temporal
      const workflowService = WorkflowService.getInstance();
      const scheduleParams: ScheduleCustomerSupportParams = {
        analysisArray,
        site_id: siteId,
        userId: userId
      };
      
      const result = await workflowService.scheduleCustomerSupport(scheduleParams);
      
      if (result.success) {
        console.log(`[EMAIL_API] Customer support programado exitosamente: ${result.workflowId}`);
      } else {
        console.error(`[EMAIL_API] Error al programar customer support:`, result.error);
      }
    } else {
      console.log(`[EMAIL_API] No se encontraron análisis para programar customer support`);
    }
  } catch (error) {
    console.error(`[EMAIL_API] Error en scheduleCustomerSupportAfterAnalysis:`, error);
  }
}

// Create command object for email analysis
function createEmailCommand(agentId: string, siteId: string, emails: any[], analysisType?: string, leadId?: string, teamMemberId?: string, userId?: string) {
  const defaultUserId = '00000000-0000-0000-0000-000000000000';

  return CommandFactory.createCommand({
    task: 'analyze emails',
    userId: userId || teamMemberId || defaultUserId,
    agentId: agentId,
    site_id: siteId,
    description: 'Analyze incoming emails to determine if they require a commercial response, categorize them, and suggest appropriate actions.',
    targets: [
      {
        analysis: {
          summary: "",
          insights: [],
          sentiment: "positive | negative | neutral",
          priority: "high | medium | low",
          action_items: [],
          response: [],
          lead_extraction: {
            contact_info: {
              name: null,
              email: null,
              phone: null,
              company: null
            },
            intent: "inquiry | complaint | purchase | support | partnership | demo_request",
            requirements: [],
            budget_indication: null,
            timeline: null,
            decision_maker: "yes | no | unknown",
            source: "website | referral | social_media | advertising | cold_outreach"
          },
          commercial_opportunity: {
            requires_response: false,
            response_type: "commercial | support | informational | follow_up",
            priority_level: "high | medium | low",
            suggested_actions: [],
            potential_value: "high | medium | low | unknown",
            next_steps: []
          }
        }
      }
    ],
    tools: [],
    context: JSON.stringify({
      emails,
      site_id: siteId,
      analysis_type: analysisType,
      lead_id: leadId,
      team_member_id: teamMemberId
    }),
    supervisor: [
      { agent_role: "email_specialist", status: "not_initialized" },
      { agent_role: "sales_manager", status: "not_initialized" },
      { agent_role: "customer_service_manager", status: "not_initialized" }
    ],
    model: "gpt-4",
    modelType: "openai"
  });
}

// Main POST endpoint to analyze emails
export async function POST(request: NextRequest) {
  try {
    // Get and validate request data
    const requestData = await request.json();
    console.log('[EMAIL_API] Request data received:', JSON.stringify(requestData, null, 2));
    
    const validationResult = EmailAgentRequestSchema.safeParse(requestData);
    
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
    
    const { site_id, limit = 10, lead_id, agentId, team_member_id, analysis_type, user_id, since_date } = validationResult.data;
    
    try {
      // Get email configuration
      const emailConfig = await EmailConfigService.getEmailConfig(site_id);
      
      // Fetch emails
      const emails = await EmailService.fetchEmails(emailConfig, limit, since_date);

      // Si no se proporciona agentId, buscar el agente de soporte
      const effectiveAgentId = agentId || await findSupportAgent(site_id);
      
      // Create and submit command
      const command = createEmailCommand(effectiveAgentId, site_id, emails, analysis_type, lead_id, team_member_id, user_id);
      const internalCommandId = await commandService.submitCommand(command);
      
      console.log(`📝 Comando creado con ID interno: ${internalCommandId}`);
      
      // Intentar obtener el UUID de la base de datos inmediatamente después de crear el comando
      let initialDbUuid = await getCommandDbUuid(internalCommandId);
      if (initialDbUuid) {
        console.log(`📌 UUID de base de datos obtenido inicialmente: ${initialDbUuid}`);
      }
      
      // Esperar a que el comando se complete utilizando nuestra función
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
      
      // Extraer los análisis de los results/targets para programar customer support
      const analysisArray: AnalysisData[] = [];
      
      if (executedCommand && executedCommand.results && Array.isArray(executedCommand.results)) {
        for (const result of executedCommand.results) {
          if (result.analysis) {
            analysisArray.push(result.analysis as AnalysisData);
          }
        }
      }
      
      // Si también hay targets con análisis, los incluimos
      if (executedCommand && executedCommand.targets && Array.isArray(executedCommand.targets)) {
        for (const target of executedCommand.targets) {
          if (target.analysis) {
            analysisArray.push(target.analysis as AnalysisData);
          }
        }
      }
      
      // Programar customer support de forma asíncrona (sin bloquear la respuesta)
      const effectiveUserId = user_id || team_member_id || '00000000-0000-0000-0000-000000000000';
      console.log(`[EMAIL_API] Programando customer support asíncronamente...`);
      
      // Ejecutar sin await para no bloquear la respuesta
      scheduleCustomerSupportAfterAnalysis(analysisArray, site_id, effectiveUserId)
        .catch(error => {
          console.error(`[EMAIL_API] Error en programación asíncrona de customer support:`, error);
        });
      
      return NextResponse.json({
        success: true,
        data: {
          commandId: effectiveDbUuid || internalCommandId,
          status: executedCommand?.status || 'completed',
          message: "Análisis de emails completado exitosamente",
          emailCount: emails.length,
          analysisCount: analysisArray.length
        }
      });
      
    } catch (error: unknown) {
      const isConfigError = error instanceof Error && (
        error.message.includes('settings') || 
        error.message.includes('token')
      );

      const isAgentError = error instanceof Error && 
        error.message.includes('agente de soporte');
        
      return NextResponse.json(
        {
          success: false,
          error: {
            code: isConfigError ? ERROR_CODES.EMAIL_CONFIG_NOT_FOUND : 
                  isAgentError ? ERROR_CODES.AGENT_NOT_FOUND :
                  ERROR_CODES.EMAIL_FETCH_ERROR,
            message: error instanceof Error ? error.message : "Error procesando emails",
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

// GET method for backward compatibility, returns an empty response with a message
export async function GET(request: NextRequest) {
  return NextResponse.json({
    success: true,
    message: "This endpoint requires a POST request with email analysis parameters. Please refer to the documentation."
  }, { status: 200 });
} 