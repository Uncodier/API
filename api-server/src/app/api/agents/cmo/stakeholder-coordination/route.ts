import { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { 
  AgentService, 
  DataService, 
  ResourceService, 
  VapiService 
} from './services';

// Inicializar el sistema de agentes
AgentService.initialize();

export async function POST(request: Request) {
  try {
    // Parse el cuerpo de la solicitud
    const requestData = await request.json();
    
    // Extraer los parámetros necesarios
    const {
      meeting_title,
      meeting_objective,
      participants,
      meeting_agenda,
      visitor_id,
      lead_id,
      userId,
      conversationId,
      agentId,
      site_id,
      include_context_summary = true,
      phone_numbers = [] // Números de teléfono para la llamada
    } = requestData;

    // Validar campos requeridos
    if (!site_id) {
      return NextResponse.json({
        success: false,
        error: { code: 'INVALID_REQUEST', message: 'Missing required field: site_id' }
      }, { status: 400 });
    }

    // Verificar identificación del usuario - al menos visitor_id o lead_id si no hay userId
    if (!userId && !visitor_id && !lead_id) {
      return NextResponse.json({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'At least one identification parameter (visitor_id, lead_id, or userId) is required'
        }
      }, { status: 400 });
    }

    // Lógica para obtener el agente efectivo
    const effectiveAgentId = await AgentService.findEffectiveAgent(site_id, agentId, 'cmo');

    // Usar userId si está disponible, de lo contrario generar uno basado en visitor_id o lead_id
    const effectiveUserId = userId || `system_${visitor_id || lead_id}`;
    
    // Usar el site_id proporcionado
    const effectiveSiteId = site_id;

    // Generar un mensaje de contexto
    let contextMessage = '';
    
    // Incluir detalles básicos si se proporcionan
    if (meeting_title) {
      contextMessage += `## Meeting Title\n${meeting_title}\n\n`;
    }
    
    if (meeting_objective) {
      contextMessage += `## Meeting Objective\n${meeting_objective}\n\n`;
    }
    
    if (meeting_agenda) {
      contextMessage += `## Meeting Agenda\n${meeting_agenda}\n\n`;
    }
    
    if (participants && Array.isArray(participants) && participants.length > 0) {
      contextMessage += `## Participants\n`;
      participants.forEach((participant: string) => {
        contextMessage += `- ${participant}\n`;
      });
      contextMessage += '\n';
    }

    // Generar resumen de contexto detallado si se ha solicitado
    if (include_context_summary) {
      // Obtener datos de contexto de la base de datos usando los servicios
      const existingTasks = await DataService.getExistingTasks(effectiveSiteId, participants);
      const pendingRequirements = await DataService.getPendingRequirements(effectiveSiteId);
      const activeCampaigns = await DataService.getActiveCampaigns(effectiveSiteId);
      const contentInventory = await DataService.getContentInventory(effectiveSiteId);
      const resourceAllocation = await ResourceService.getResourceAllocation(effectiveSiteId);
      
      // Agregar al contexto con mejor formato
      contextMessage += '## CONTEXT SUMMARY\n\n';
      
      if (existingTasks) {
        contextMessage += '### EXISTING TASKS\n';
        contextMessage += existingTasks + '\n\n';
      }
      
      if (pendingRequirements) {
        contextMessage += '### PENDING REQUIREMENTS\n';
        contextMessage += pendingRequirements + '\n\n';
      }
      
      if (activeCampaigns) {
        contextMessage += '### ACTIVE CAMPAIGNS\n';
        contextMessage += activeCampaigns + '\n\n';
      }
      
      if (contentInventory) {
        contextMessage += '### CONTENT INVENTORY\n';
        contextMessage += contentInventory + '\n\n';
      }
      
      if (resourceAllocation) {
        contextMessage += '### RESOURCE ALLOCATION\n';
        contextMessage += resourceAllocation + '\n\n';
      }
    }
    
    // Agregar instrucciones para el agente
    contextMessage += `## Instructions for the CMO Agent

IMPORTANT: These are instructions for you, NOT the actual message content to deliver.

You are preparing for a high-stakes meeting with the CEO where multiple stakeholders will be present. As the CMO agent, your role is to help coordinate this meeting effectively, ensuring all stakeholders are aligned and that concrete decisions are made.

MEETING CONTEXT:
- This is a CEO-level meeting with marketing stakeholders from different departments
- The discussion requires balancing multiple perspectives and priorities
- You must help facilitate clear decision-making and action item assignments
- You need to ensure the CEO receives clear, concise strategic recommendations

For this stakeholder coordination meeting:
1. Begin with a clear introduction and agenda review
2. Reference the existing tasks, requirements, campaigns and content when relevant
3. Maintain focus on decision-making throughout the discussion
4. Ensure all stakeholder perspectives are acknowledged, but keep the meeting on track
5. Conclude with explicit next steps and action items with clear ownership
6. After the meeting, prepare a comprehensive summary including key points, decisions, and tasks

Remember: This is not just a conversation - you are facilitating a strategic discussion with the CEO and multiple stakeholders that should result in concrete marketing initiatives and clear ownership of next steps.`;

    // Command system message - adding to the context
    contextMessage += `

## Command System Instructions

Based on the information provided in the context, create messages that the CMO agent should address during the stakeholder coordination meeting with the CEO. These messages should focus on:

1. Decision-making regarding overdue tasks
2. Discussion about pending budgets and their allocation
3. Prioritization of marketing requirements
4. Evaluation of active campaigns and their performance
5. Resource allocation for future initiatives

Generate specific and actionable messages that:
- Reference concrete data from the provided context
- Pose questions about pending strategic decisions
- Suggest specific actions with clear responsible parties
- Connect budget decisions with expected ROI
- Maintain focus on key strategic objectives

Messages should be concise, action-oriented, and help facilitate effective decision-making during the meeting.

REQUIRED FORMATS:
1. DECISION POINT MESSAGE: Present a pending decision with clear options
2. TASK ASSIGNMENT MESSAGE: Define specific tasks with deadlines and responsible parties
3. PRIORITIZATION MESSAGE: Establish priorities among different initiatives or requirements

Each message should be supported by data available in the context and facilitate executive decision-making.`;

    console.log(`📝 Contexto generado con ${contextMessage.length} caracteres`);

    // Valores predeterminados para el título y objetivo si no se proporcionan
    const defaultTitle = meeting_title || "Marketing Strategy Discussion";
    const defaultObjective = meeting_objective || "Discuss marketing strategy and align on priorities";

    // Mensajes de sistema para la llamada
    const preCallSystemMessage = `You are a CMO agent facilitating a CEO-level meeting with multiple stakeholders. Your primary objective is to coordinate an effective discussion about marketing strategy and identify clear priorities. These are your guiding instructions, not the message itself.

KEY TALKING POINTS:
1. Current marketing performance metrics review
2. Analysis of channel performance and engagement
3. Opportunity identification across channels
4. Budget allocation considerations
5. Resource needs assessment

DOS:
- Reference specific metrics from relevant reports
- Ask for participant input on strategic decisions
- Suggest concrete next steps for each action item
- Connect budget decisions to expected ROI
- Maintain focus on strategic objectives
- Ensure the CEO receives clear, actionable recommendations
- Balance input from all stakeholders while keeping the meeting focused

DON'TS:
- Don't discuss personnel matters beyond resource requirements
- Avoid excessive technical details on implementation
- Don't commit to specific budget numbers without approval
- Don't mention competitor strategies that haven't been cleared for discussion
- Avoid discussing sensitive product roadmap items not on the agenda
- Don't let the discussion become unfocused or dominated by a single stakeholder

PENDING TASKS TO REFERENCE:
Refer to existing tasks and initiatives in the context

REQUIRED MESSAGES:
1. You MUST provide a summary message that captures the key points discussed
2. You MUST include at least one message with specific action items and who is responsible for each
3. You MUST provide clear guidance on things to pursue and things to avoid

After the meeting, be prepared to generate a comprehensive summary with key points, decisions made, actionable tasks with assignees, and project requirements.`;

    // Crear el comando utilizando los servicios
    const commandData = {
      task: 'stakeholder meeting',
      userId: effectiveUserId,
      agentId: effectiveAgentId,
      site_id: effectiveSiteId,
      description: 'Create comprehensive guidance for a CMO agent navigating high-stakes marketing strategy discussions.',
      targets: [
        {
          meeting_details: {
            title: defaultTitle,
            objective: defaultObjective,
            dynamic: !meeting_title || !meeting_objective // Indicar si debe generarse dinámicamente
          }
        },
        {
          messages: [
            {
              role: "system",
              content: preCallSystemMessage // Using preCallSystemMessage as a placeholder since the real instructions are in context
            }
          ]
        }
      ],
      context: contextMessage,
      supervisor: [
        {
          agent_role: "marketing_director",
          status: "not_initialized"
        }
      ],
    };

    // Enviar el comando para su procesamiento, manejando el caso de agentId nulo
    let internalCommandId;
    if (effectiveAgentId === null) {
      console.log('🚀 Creando comando sin agente asociado');
      internalCommandId = await AgentService.createCommandWithoutAgent(commandData);
    } else {
      console.log(`🚀 Creando comando con agente: ${effectiveAgentId}`);
      internalCommandId = await AgentService.submitCommand(commandData);
    }
    
    console.log(`📝 Comando creado con ID interno: ${internalCommandId}`);

    // Intentar obtener el UUID de la base de datos inmediatamente después de crear el comando
    let initialDbUuid = await AgentService.getCommandDbUuid(internalCommandId);
    if (initialDbUuid) {
      console.log(`📌 UUID de base de datos obtenido inicialmente: ${initialDbUuid}`);
    }

    // Esperar a que el comando se complete
    const { command: executedCommand, dbUuid, completed } = await AgentService.waitForCommandCompletion(internalCommandId);

    // Intentar obtener el UUID obtenido inicialmente si no hay un UUID válido después de la ejecución
    const effectiveDbUuid = (dbUuid && AgentService.isValidUUID(dbUuid)) ? dbUuid : initialDbUuid;

    // Extraer detalles de la reunión del comando ejecutado
    let meetingDetails = {
      title: defaultTitle,
      objective: defaultObjective
    };
    
    // Intentar obtener los detalles de la reunión si se generaron dinámicamente
    if (executedCommand.targets && Array.isArray(executedCommand.targets) && executedCommand.targets.length > 0) {
      const detailsTarget = executedCommand.targets.find((target: any) => target.meeting_details);
      if (detailsTarget && detailsTarget.meeting_details) {
        meetingDetails = {
          title: detailsTarget.meeting_details.title || meetingDetails.title,
          objective: detailsTarget.meeting_details.objective || meetingDetails.objective
        };
      }
    }

    // Preparar los system prompts para la respuesta
    const systemPrompts: Array<{id: string; role: string; phase: string; content: string}> = [];
    
    if (executedCommand.targets && Array.isArray(executedCommand.targets)) {
      executedCommand.targets.forEach((target: any, index: number) => {
        if (target.messages && Array.isArray(target.messages)) {
          target.messages.forEach((message: any) => {
            if (message.role === 'system') {
              systemPrompts.push({
                id: `prompt_${index + 123}`,
                role: 'system',
                phase: 'pre_call', // Siempre pre_call ahora que eliminamos post_call
                content: message.content
              });
            }
          });
        }
      });
    }
    
    // Extract command results to include in the response
    const commandResults = executedCommand?.results || [];
    
    // Iniciar una llamada con Vapi si hay números de teléfono y el comando está completado
    let callDetails = null;
    
    // Determinar si podemos usar Vapi basado en el estado del comando
    const shouldUseVapi = completed && 
                        phone_numbers && 
                        Array.isArray(phone_numbers) && 
                        phone_numbers.length > 0;
    
    if (shouldUseVapi) {
      console.log(`✅ Comando completado correctamente. Procediendo con integración Vapi.`);
      
      try {
        // Usar el agent_background del comando ejecutado si está disponible
        let systemPromptContent;
        
        if (executedCommand.agent_background) {
          systemPromptContent = executedCommand.agent_background;
        } else {
          // Fallback al método anterior
          systemPromptContent = `${preCallSystemMessage}\n\n${executedCommand.context}`;
        }
        
        // Iniciar la llamada usando el servicio de Vapi
        callDetails = await VapiService.initiateCall(
          phone_numbers[0],
          meetingDetails,
          preCallSystemMessage, // El mensaje de sistema original para Vapi
          executedCommand.agent_background
        );
      } catch (vapiError) {
        console.error('Error al crear llamada Vapi:', vapiError);
        callDetails = {
          id: `error-${Date.now()}`,
          status: "failed",
          phone_number: phone_numbers[0]
        };
      }
    } else if (phone_numbers && Array.isArray(phone_numbers) && phone_numbers.length > 0) {
      // Si hay números de teléfono pero el comando no está completado
      console.log(`⚠️ Se proporcionaron números de teléfono pero el comando no está completado (estado: ${executedCommand?.status || 'desconocido'})`);
      console.log(`⚠️ La llamada con Vapi no se iniciará hasta que el comando esté completado.`);
      
      callDetails = {
        id: `pending-${Date.now()}`,
        status: "pending_command_completion",
        phone_number: phone_numbers[0]
      };
    }

    // Definir la interfaz de respuesta
    interface ResponseData {
      success: boolean;
      data: {
        command_id: string;
        conversation_id: string;
        status: string;
        meeting_details: {
          title: string;
          objective: string;
        };
        system_prompts: Array<{id: string; role: string; phase: string; content: string}>;
        command_results: any[];
        call?: {
          id: string;
          status: string;
          phone_number: string;
        };
      };
    }

    // Preparar respuesta
    const responseData: ResponseData = {
      success: true,
      data: {
        command_id: effectiveDbUuid || internalCommandId,
        conversation_id: conversationId || uuidv4(),
        status: completed ? "completed" : "processing",
        meeting_details: meetingDetails,
        system_prompts: systemPrompts,
        command_results: commandResults
      }
    };

    // Agregar información de la llamada si se intentó
    if (callDetails) {
      responseData.data.call = callDetails;
    }

    return NextResponse.json(responseData);
  } catch (error) {
    console.error('Error al procesar la solicitud:', error);
    return NextResponse.json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected error occurred while processing the request'
      }
    }, { status: 500 });
  }
} 