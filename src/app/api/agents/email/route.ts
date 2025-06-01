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

// Create command object for email analysis
function createEmailCommand(agentId: string, siteId: string, emails: any[], emailConfig: any, analysisType?: string, leadId?: string, teamMemberId?: string, userId?: string) {
  const defaultUserId = '00000000-0000-0000-0000-000000000000';

  return CommandFactory.createCommand({
    task: 'analyze emails',
    userId: userId || teamMemberId || defaultUserId,
    agentId: agentId,
    site_id: siteId,
    description: 'Identify potential leads and commercial opportunities. Focus ONLY on emails from prospects showing genuine interest in our products/services. IGNORE: transactional emails, vendor outreach, spam, and cold sales pitches from other companies unless they demonstrate clear interest in becoming customers. IMPORTANT: If no emails require a response or qualify as potential leads, return an empty array in the results. []',
    targets: [
      {
        email: {
          original_subject: "Original subject of the email",
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
      emails,
      site_id: siteId,
      inbox_info: {
        email_address: emailConfig?.email_address || 'unknown',
        provider: emailConfig?.provider || 'unknown',
        display_name: emailConfig?.display_name || emailConfig?.email_address || 'Unknown Inbox',
        company_name: emailConfig?.company_name || 'Unknown Company',
        business_type: emailConfig?.business_type || 'Unknown Business Type',
        industry: emailConfig?.industry || 'Unknown Industry'
      },
      email_count: emails.length,
      analysis_type: analysisType,
      lead_id: leadId,
      team_member_id: teamMemberId,
      special_instructions: 'This is not a summary of the email inbox, its a regontition of each individual email with a commercial interest. Ignore all emails from the team members, do not-reply emails, and spam emails.'
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
      const command = createEmailCommand(effectiveAgentId, site_id, emails, emailConfig, analysis_type, lead_id, team_member_id, user_id);
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
      
      // Extraer los datos de email de los results para incluir en la respuesta
      // NOTA: Solo extraemos de results, NO de targets (que contienen solo templates)
      const emailsForResponse: any[] = [];
      
      console.log(`[EMAIL_API] 🔍 Diagnosticando comando ejecutado:`);
      console.log(`[EMAIL_API] executedCommand existe: ${!!executedCommand}`);
      console.log(`[EMAIL_API] executedCommand.results existe: ${!!(executedCommand && executedCommand.results)}`);
      console.log(`[EMAIL_API] executedCommand.results es array: ${!!(executedCommand && executedCommand.results && Array.isArray(executedCommand.results))}`);
      console.log(`[EMAIL_API] executedCommand.results.length: ${executedCommand?.results?.length || 0}`);
      
      if (executedCommand) {
        console.log(`[EMAIL_API] 📋 Estructura completa del comando:`, JSON.stringify({
          status: executedCommand.status,
          results: executedCommand.results,
          targets: executedCommand.targets,
          resultsCount: executedCommand.results?.length || 0,
          targetsCount: executedCommand.targets?.length || 0
        }, null, 2));
      }
      
      // Extraer SOLO de results (que contienen los emails procesados por el agente)
      if (executedCommand && executedCommand.results && Array.isArray(executedCommand.results)) {
        console.log(`[EMAIL_API] 🔄 Iterando sobre ${executedCommand.results.length} resultados...`);
        for (const result of executedCommand.results) {
          console.log(`[EMAIL_API] 📧 Resultado encontrado:`, JSON.stringify(result, null, 2));
          if (result.email) {
            console.log(`[EMAIL_API] ✅ Email encontrado en results:`, JSON.stringify(result.email, null, 2));
            emailsForResponse.push(result.email);
          } else {
            console.log(`[EMAIL_API] ❌ Result no tiene propiedad email:`, Object.keys(result));
          }
        }
      } else {
        console.log(`[EMAIL_API] ❌ No se encontraron results válidos para procesar`);
      }
      
      // NO extraer de targets ya que contienen solo templates/placeholders
      // Los targets son la estructura esperada, no los resultados reales
      
      console.log(`[EMAIL_API] 📊 Emails extraídos para respuesta: ${emailsForResponse.length}`);
      
      return NextResponse.json({
        success: true,
        data: {
          commandId: effectiveDbUuid || internalCommandId,
          status: executedCommand?.status || 'completed',
          message: "Análisis de emails completado exitosamente",
          emailCount: emails.length,
          analysisCount: emailsForResponse.length,
          emails: emailsForResponse
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

// Función de validación de email
function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
} 