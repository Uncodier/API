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

/**
 * Espera la finalización del comando y programa el customer support
 */
async function waitForCommandAndScheduleSupport(
  commandId: string, 
  siteId: string, 
  userId: string
): Promise<void> {
  try {
    console.log(`[EMAIL_API] Esperando finalización del comando: ${commandId}`);
    
    // Configurar timeout para evitar esperas infinitas
    const timeout = 5 * 60 * 1000; // 5 minutos
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      try {
        const command = await commandService.getCommandById(commandId);
        
        if (command && command.status === 'completed') {
          console.log(`[EMAIL_API] Comando completado, extrayendo análisis...`);
          
          // Extraer los datos de análisis de los targets
          const analysisArray: AnalysisData[] = [];
          
          if (command.targets && Array.isArray(command.targets)) {
            for (const target of command.targets) {
              if (target.analysis) {
                analysisArray.push(target.analysis as AnalysisData);
              }
            }
          }
          
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
            console.log(`[EMAIL_API] No se encontraron análisis en el comando completado`);
          }
          
          return; // Salir del bucle
        }
        
        if (command && command.status === 'failed') {
          console.error(`[EMAIL_API] Comando falló, no se puede programar customer support`);
          return;
        }
        
        // Esperar antes de verificar nuevamente
        await new Promise(resolve => setTimeout(resolve, 5000)); // 5 segundos
        
      } catch (error) {
        console.error(`[EMAIL_API] Error al verificar estado del comando:`, error);
        await new Promise(resolve => setTimeout(resolve, 5000)); // 5 segundos
      }
    }
    
    console.warn(`[EMAIL_API] Timeout esperando finalización del comando: ${commandId}`);
    
  } catch (error) {
    console.error(`[EMAIL_API] Error en waitForCommandAndScheduleSupport:`, error);
  }
}

// Create command object for email analysis
function createEmailCommand(agentId: string, siteId: string, emails: any[], analysisType?: string, leadId?: string, teamMemberId?: string, userId?: string) {
  const defaultUserId = '00000000-0000-0000-0000-000000000000';

  return CommandFactory.createCommand({
    task: 'analyze_emails',
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
    tools: [
      {
        name: "email_analysis",
        description: "analyze email content and metadata",
        status: "not_initialized",
        type: "synchronous",
        parameters: {
          type: "object",
          properties: {
            content: { type: "string", description: "The email content to analyze" },
            metadata: { type: "object", description: "Email metadata like sender, subject, date" }
          },
          required: ["content"]
        }
      },
      {
        name: "sentiment_analysis",
        description: "analyze sentiment and tone of email content",
        status: "not_initialized",
        type: "synchronous",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "The text content to analyze for sentiment" }
          },
          required: ["text"]
        }
      }
    ],
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
      
      // Ejecutar programación de customer support de forma asíncrona (sin bloquear la respuesta)
      const effectiveUserId = user_id || team_member_id || '00000000-0000-0000-0000-000000000000';
      console.log(`[EMAIL_API] Programando customer support asíncronamente para comando: ${internalCommandId}`);
      
      // Ejecutar sin await para no bloquear la respuesta
      waitForCommandAndScheduleSupport(internalCommandId, site_id, effectiveUserId)
        .catch(error => {
          console.error(`[EMAIL_API] Error en programación asíncrona de customer support:`, error);
        });
      
      return NextResponse.json({
        success: true,
        data: {
          commandId: internalCommandId,
          status: "processing",
          message: "Comando creado con éxito",
          emailCount: emails.length
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