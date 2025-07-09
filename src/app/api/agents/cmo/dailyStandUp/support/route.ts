import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Función para validar valores de estado de la base de datos
function validateDatabaseEnumValues() {
  return {
    tasks: {
      validStatuses: ['completed', 'in_progress', 'pending', 'failed'],
      isValidStatus: (status: string) => ['completed', 'in_progress', 'pending', 'failed'].includes(status)
    },
    commands: {
      validStatuses: ['pending', 'running', 'completed', 'failed', 'cancelled'],
      isValidStatus: (status: string) => ['pending', 'running', 'completed', 'failed', 'cancelled'].includes(status)
    },
    requirements: {
      validStatuses: ['validated', 'in-progress', 'on-review', 'done', 'backlog', 'canceled'],
      isValidStatus: (status: string) => ['validated', 'in-progress', 'on-review', 'done', 'backlog', 'canceled'].includes(status)
    }
  };
}

// Función para guardar en agent_memories
async function saveToAgentMemory(agentId: string, userId: string, commandId: string, analysisData: any, siteId: string): Promise<{success: boolean, memoryId?: string, error?: string}> {
  try {
    const memoryId = uuidv4();
    const memoryKey = `daily_standup_support_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    
    // Validar que command_id sea un UUID válido antes de guardarlo en la base de datos
    const validCommandId = commandId && isValidUUID(commandId) ? commandId : null;
    
    const memoryData = {
      id: memoryId,
      agent_id: agentId,
      user_id: userId,
      command_id: validCommandId,
      type: 'daily_standup_support',
      key: memoryKey,
      data: {
        analysis_type: 'support_performance_assessment',
        support_analysis: analysisData,
        timestamp: new Date().toISOString(),
        site_id: siteId,
        command_id: commandId, // Mantener el ID original en data para referencia
        support_metrics: {
          analysis_completed: true,
          tasks_reviewed: true,
          conversations_assessed: true
        }
      },
      raw_data: JSON.stringify(analysisData),
      metadata: {
        source: 'daily_standup_support',
        analysis_type: 'cmo_support_analysis',
        importance: 'high',
        retention_policy: '7_days',
        original_command_id: commandId || null
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      access_count: 0,
      last_accessed: new Date().toISOString()
    };

    console.log(`💾 Guardando análisis de soporte en agent_memories para agente: ${agentId} (command_id: ${commandId})`);

    const { data, error } = await supabaseAdmin
      .from('agent_memories')
      .insert([memoryData])
      .select('id')
      .single();

    if (error) {
      console.error('❌ Error guardando en agent_memories:', error);
      return {
        success: false,
        error: error.message
      };
    }

    console.log(`✅ Memoria de soporte guardada con ID: ${data.id}`);
    
    return {
      success: true,
      memoryId: data.id
    };

  } catch (error) {
    console.error('❌ Error en saveToAgentMemory:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

// Función para encontrar un agente de CMO activo para un sitio
async function findActiveCmoAgent(siteId: string): Promise<{agentId: string, userId: string} | null> {
  try {
    if (!siteId || !isValidUUID(siteId)) {
      console.error(`❌ Invalid site_id for agent search: ${siteId}`);
      return null;
    }
    
    console.log(`🔍 Buscando agente de CMO activo para el sitio: ${siteId}`);
    
    const { data, error } = await supabaseAdmin
      .from('agents')
      .select('id, user_id')
      .eq('site_id', siteId)
      .eq('role', 'Customer Support')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1);
    
    if (error) {
      console.error('Error al buscar agente de CMO:', error);
      return null;
    }
    
    if (!data || data.length === 0) {
      console.log(`⚠️ No se encontró ningún agente de CMO activo para el sitio: ${siteId}`);
      return null;
    }
    
    console.log(`✅ Agente de CMO encontrado: ${data[0].id} (user_id: ${data[0].user_id})`);
    return {
      agentId: data[0].id,
      userId: data[0].user_id
    };
  } catch (error) {
    console.error('Error al buscar agente de CMO:', error);
    return null;
  }
}

// Función para obtener datos de soporte
// Valid enum values for database tables:
// - tasks.status: 'completed', 'in_progress', 'pending', 'failed'
// - commands.status: 'pending', 'running', 'completed', 'failed', 'cancelled'
// - requirements.status: 'validated', 'in-progress', 'on-review', 'done', 'backlog', 'canceled'
async function getSupportData(siteId: string) {
  try {
    console.log(`🎧 Obteniendo datos de soporte para site_id: ${siteId}`);
    
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    
    // Obtener tareas abiertas
    const { data: openTasks, error: tasksError } = await supabaseAdmin
      .from('tasks')
      .select('*')
      .eq('site_id', siteId)
      .in('status', ['in_progress', 'pending'])
      .order('created_at', { ascending: false })
      .limit(50);
    
    if (tasksError) {
      console.error('Error al obtener tareas:', tasksError);
      // Return early if there's a critical database error
      if (tasksError.code === '22P02') {
        console.error('❌ Database enum error in tasks query:', tasksError.message);
        return null;
      }
    }
    
    // Obtener conversaciones de soporte recientes
    const { data: supportConversations, error: conversationsError } = await supabaseAdmin
      .from('conversations')
      .select('*, messages(*)')
      .eq('site_id', siteId)
      .not('visitor_id', 'is', null)
      .gte('updated_at', yesterday)
      .order('updated_at', { ascending: false })
      .limit(20);
    
    if (conversationsError) {
      console.error('Error al obtener conversaciones de soporte:', conversationsError);
    }
    
    // Obtener comandos de soporte activos
    const { data: supportCommands, error: commandsError } = await supabaseAdmin
      .from('commands')
      .select('*')
      .eq('site_id', siteId)
      .in('task', ['customer support', 'ticket analysis', 'user assistance'])
      .in('status', ['pending', 'running'])
      .order('created_at', { ascending: false })
      .limit(20);
    
    if (commandsError) {
      console.error('Error al obtener comandos de soporte:', commandsError);
      // Return early if there's a critical database error
      if (commandsError.code === '22P02') {
        console.error('❌ Database enum error in commands query:', commandsError.message);
        return null;
      }
    }
    
    // Obtener agente de soporte activo
    const { data: supportAgent, error: supportAgentError } = await supabaseAdmin
      .from('agents')
      .select('id, user_id, status')
      .eq('site_id', siteId)
      .eq('role', 'Customer Support')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1);
    
    if (supportAgentError) {
      console.error('Error al obtener agente de soporte:', supportAgentError);
    }
    
    // Obtener requerimientos no completados
    const { data: pendingRequirements, error: requirementsError } = await supabaseAdmin
      .from('requirements')
      .select('*')
      .eq('site_id', siteId)
      .in('status', ['validated', 'in-progress'])
      .order('created_at', { ascending: false })
      .limit(30);
    
    if (requirementsError) {
      console.error('Error al obtener requerimientos:', requirementsError);
      // Return early if there's a critical database error
      if (requirementsError.code === '22P02') {
        console.error('❌ Database enum error in requirements query:', requirementsError.message);
        return null;
      }
    }
    
    return {
      openTasks: openTasks || [],
      supportConversations: supportConversations || [],
      supportCommands: supportCommands || [],
      supportAgent: supportAgent?.[0] || null,
      pendingRequirements: pendingRequirements || [],
      openTasksCount: openTasks?.length || 0,
      conversationsCount: supportConversations?.length || 0,
      activeCommandsCount: supportCommands?.length || 0,
      pendingRequirementsCount: pendingRequirements?.length || 0
    };
  } catch (error) {
    console.error('Error al obtener datos de soporte:', error);
    return null;
  }
}

// Función para esperar a que un comando se complete
async function waitForCommandCompletion(commandService: any, commandId: string, maxAttempts = 100, delayMs = 1000) {
  let executedCommand = null;
  let attempts = 0;
  
  console.log(`⏳ Esperando a que se complete el comando ${commandId}...`);
  
  return new Promise<{command: any, completed: boolean}>((resolve) => {
    const checkInterval = setInterval(async () => {
      attempts++;
      
      try {
        executedCommand = await commandService.getCommandById(commandId);
        
        if (!executedCommand) {
          console.log(`⚠️ No se pudo encontrar el comando ${commandId}`);
          clearInterval(checkInterval);
          resolve({command: null, completed: false});
          return;
        }
        
        if (executedCommand.status === 'completed' || executedCommand.status === 'failed') {
          console.log(`✅ Comando ${commandId} completado con estado: ${executedCommand.status}`);
          clearInterval(checkInterval);
          resolve({command: executedCommand, completed: executedCommand.status === 'completed'});
          return;
        }
        
        console.log(`⏳ Comando ${commandId} aún en ejecución (estado: ${executedCommand.status}), intento ${attempts}/${maxAttempts}`);
        
        if (attempts >= maxAttempts) {
          console.log(`⏰ Tiempo de espera agotado para el comando ${commandId}`);
          clearInterval(checkInterval);
          resolve({command: executedCommand, completed: false});
        }
      } catch (error) {
        console.error(`Error al verificar estado del comando ${commandId}:`, error);
        clearInterval(checkInterval);
        resolve({command: null, completed: false});
      }
    }, delayMs);
  });
}

// Inicializar el agente y obtener el servicio de comandos
const processorInitializer = ProcessorInitializer.getInstance();
processorInitializer.initialize();
const commandService = processorInitializer.getCommandService();

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { site_id, command_id } = body;
    
    if (!site_id || !isValidUUID(site_id)) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'site_id is required and must be a valid UUID' } },
        { status: 400 }
      );
    }
    
    // Buscar agente de CMO activo
    const agent = await findActiveCmoAgent(site_id);
    if (!agent) {
      return NextResponse.json(
        { success: false, error: { code: 'AGENT_NOT_FOUND', message: 'No active CMO agent found for this site' } },
        { status: 404 }
      );
    }
    
    console.log(`🤖 Iniciando daily standup support para agente: ${agent.agentId}, usuario: ${agent.userId}, sitio: ${site_id}`);
    
    // Obtener datos de soporte
    const supportData = await getSupportData(site_id);
    
    if (!supportData) {
      return NextResponse.json(
        { success: false, error: { code: 'DATA_ERROR', message: 'Could not retrieve support data' } },
        { status: 500 }
      );
    }
    
    // Preparar contexto con los datos de soporte
    const contextMessage = `Daily StandUp - Support Analysis for Site: ${site_id}
    
Support Performance (Last 24h):
- Open Tasks: ${supportData.openTasksCount}
- Active Support Conversations: ${supportData.conversationsCount}
- Active Support Commands: ${supportData.activeCommandsCount}
- Pending Requirements: ${supportData.pendingRequirementsCount}
- Support Agent Status: ${supportData.supportAgent ? 'Active' : 'Not Found'}

Open Tasks Summary:
${supportData.openTasks.slice(0, 10).map((task: any, index: number) => 
  `${index + 1}. ${task.title || 'Untitled'} - Priority: ${task.priority || 'Normal'} - Status: ${task.status}`
).join('\n')}

Recent Support Conversations:
${supportData.supportConversations.slice(0, 5).map((conv: any, index: number) => 
  `${index + 1}. Conversation ${conv.id} - Messages: ${conv.messages?.length || 0} - Last update: ${conv.updated_at}`
).join('\n')}

Pending Requirements:
${supportData.pendingRequirements.slice(0, 10).map((req: any, index: number) => 
  `${index + 1}. ${req.title || 'Untitled'} - Type: ${req.type || 'General'} - Status: ${req.status}`
).join('\n')}

Support Team Coordination:
- Support Agent ID: ${supportData.supportAgent?.id || 'No active agent'}
- Active Commands: ${supportData.activeCommandsCount}
- Task Load: ${supportData.openTasksCount > 20 ? 'High' : supportData.openTasksCount > 10 ? 'Medium' : 'Low'}

Please analyze these support aspects and provide a comprehensive summary focusing on:
1. Support workload and task management efficiency
2. Customer satisfaction trends from conversations
3. Requirements backlog and prioritization
4. Support team capacity and resource allocation`;
    
    // Crear el comando
    const command = CommandFactory.createCommand({
      task: 'daily standup support analysis',
      userId: agent.userId,
      agentId: agent.agentId,
      site_id: site_id,
      description: 'Analyze support performance, tasks, conversations, and requirements for daily standup report',
      targets: [
        {
          support_analysis: {
            analysis_type: "daily_standup_support",
            tasks_data: supportData.openTasks,
            conversations_data: supportData.supportConversations,
            requirements_data: supportData.pendingRequirements,
            performance_metrics: {
              open_tasks_count: supportData.openTasksCount,
              conversations_count: supportData.conversationsCount,
              active_commands_count: supportData.activeCommandsCount,
              pending_requirements_count: supportData.pendingRequirementsCount
            }
          }
        }
      ],
      tools: [
       
      ],
      context: contextMessage,
      supervisor: [
        {
          agent_role: "support_manager",
          status: "not_initialized"
        }
      ]
    });
    
    // Enviar comando para procesamiento
    const internalCommandId = await commandService.submitCommand(command);
    console.log(`📝 Comando support analysis creado con ID: ${internalCommandId}`);
    
    // Esperar a que el comando se complete
    const { command: executedCommand, completed } = await waitForCommandCompletion(commandService, internalCommandId);
    
    if (!completed || !executedCommand) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'COMMAND_EXECUTION_FAILED', 
            message: 'The support analysis command did not complete successfully' 
          }
        },
        { status: 500 }
      );
    }
    
    // Extraer el resumen del análisis
    let summary = "Support analysis completed";
    
    if (executedCommand.results && Array.isArray(executedCommand.results)) {
      const analysisResults = executedCommand.results.find((r: any) => 
        r.support_analysis || r.content || r.summary
      );
      
      if (analysisResults) {
        if (analysisResults.support_analysis && analysisResults.support_analysis.summary) {
          summary = analysisResults.support_analysis.summary;
        } else if (analysisResults.content) {
          summary = analysisResults.content;
        } else if (analysisResults.summary) {
          summary = analysisResults.summary;
        }
      }
    }
    
    // Asegurar que summary sea un string para evitar errores
    if (typeof summary !== 'string') {
      if (typeof summary === 'object' && summary !== null) {
        // Si es un objeto, intentar extraer información útil
        const summaryObj = summary as any;
        if (summaryObj.support_metrics || summaryObj.team_coordination) {
          summary = summaryObj.support_metrics || summaryObj.team_coordination;
        } else if (summaryObj.content) {
          summary = summaryObj.content;
        } else {
          summary = JSON.stringify(summary);
        }
      } else {
        summary = String(summary) || "Support analysis completed";
      }
    }
    
    console.log(`🎧 Support analysis completado: ${summary.substring(0, 100)}...`);
    
    // Extraer el análisis completo para guardar en memoria
    let supportAnalysis = null;
    if (executedCommand.results && Array.isArray(executedCommand.results)) {
      const analysisResults = executedCommand.results.find((r: any) => 
        r.support_analysis
      );
      
      if (analysisResults && analysisResults.support_analysis) {
        supportAnalysis = analysisResults.support_analysis;
      }
    }
    
    // Guardar en agent_memories si tenemos análisis
    if (supportAnalysis) {
      const memoryResult = await saveToAgentMemory(agent.agentId, agent.userId, executedCommand.id, supportAnalysis, site_id);
      
      if (!memoryResult.success) {
        console.warn(`⚠️ No se pudo guardar memoria de soporte: ${memoryResult.error}`);
      }
    }
    
    return NextResponse.json(
      { 
        success: true, 
        data: { 
          command_id: executedCommand.id,
          summary: summary,
          analysis_type: "support",
          support_data: {
            open_tasks_count: supportData.openTasksCount,
            conversations_count: supportData.conversationsCount,
            active_commands_count: supportData.activeCommandsCount,
            pending_requirements_count: supportData.pendingRequirementsCount,
            support_agent_active: !!supportData.supportAgent
          }
        } 
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('Error en daily standup support analysis:', error);
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'An error occurred while processing the support analysis' } },
      { status: 500 }
    );
  }
} 