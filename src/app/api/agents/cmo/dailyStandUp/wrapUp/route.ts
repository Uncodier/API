import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { supabaseAdmin } from '@/lib/database/supabase-client';

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
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
      .eq('role', 'Growth Lead/Manager')
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

// Función para obtener memorias del agente relacionadas con el command_id
async function getAgentMemories(commandIds: string[], siteId: string) {
  try {
    console.log(`🧠 Obteniendo memorias del agente para command_ids: ${commandIds.join(', ')}`);
    
    // Obtener memorias relacionadas con los command_ids
    const { data: memories, error: memoriesError } = await supabaseAdmin
      .from('agent_memories')
      .select('*')
      .in('command_id', commandIds)
      .in('type', ['daily_standup_system', 'daily_standup_sales', 'daily_standup_support', 'daily_standup_growth'])
      .order('created_at', { ascending: false });
    
    if (memoriesError) {
      console.error('Error al obtener memorias del agente:', memoriesError);
      return null;
    }
    
    // Obtener comandos completados del daily standup
    const { data: standupCommands, error: commandsError } = await supabaseAdmin
      .from('commands')
      .select('*')
      .eq('site_id', siteId)
      .in('task', ['daily standup system analysis', 'daily standup sales analysis', 'daily standup support analysis', 'daily standup growth analysis'])
      .eq('status', 'completed')
      .gte('created_at', new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString()) // Últimas 12 horas
      .order('created_at', { ascending: false });
    
    if (commandsError) {
      console.error('Error al obtener comandos de standup:', commandsError);
    }
    
    return {
      memories: memories || [],
      standupCommands: standupCommands || [],
      memoriesCount: memories?.length || 0,
      commandsCount: standupCommands?.length || 0
    };
  } catch (error) {
    console.error('Error al obtener memorias del agente:', error);
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
    const { site_id, command_ids } = body;
    
    if (!site_id || !isValidUUID(site_id)) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'site_id is required and must be a valid UUID' } },
        { status: 400 }
      );
    }
    
    // Validar command_ids si se proporcionan
    let validCommandIds: string[] = [];
    if (command_ids && Array.isArray(command_ids)) {
      validCommandIds = command_ids.filter((id: string) => isValidUUID(id));
      console.log(`📋 Command IDs proporcionados: ${validCommandIds.length} válidos de ${command_ids.length} totales`);
    }
    
    // Buscar agente de CMO activo
    const agent = await findActiveCmoAgent(site_id);
    if (!agent) {
      return NextResponse.json(
        { success: false, error: { code: 'AGENT_NOT_FOUND', message: 'No active CMO agent found for this site' } },
        { status: 404 }
      );
    }
    
    console.log(`🤖 Iniciando daily standup wrapUp para agente: ${agent.agentId}, usuario: ${agent.userId}, sitio: ${site_id}`);
    
    // Obtener memorias del agente
    const memoriesData = await getAgentMemories(validCommandIds, site_id);
    
    if (!memoriesData) {
      return NextResponse.json(
        { success: false, error: { code: 'DATA_ERROR', message: 'Could not retrieve agent memories' } },
        { status: 500 }
      );
    }
    
    // Preparar contexto con todas las memorias y análisis previos
    const systemMemories = memoriesData.memories.filter(m => m.type === 'daily_standup_system');
    const salesMemories = memoriesData.memories.filter(m => m.type === 'daily_standup_sales');
    const supportMemories = memoriesData.memories.filter(m => m.type === 'daily_standup_support');
    const growthMemories = memoriesData.memories.filter(m => m.type === 'daily_standup_growth');
    
    const contextMessage = `Daily StandUp - Executive Summary & Wrap-Up for Site: ${site_id}

CONSOLIDATED ANALYSIS FROM ALL DEPARTMENTS:

=== SYSTEM ANALYSIS ===
${systemMemories.length > 0 ? 
  systemMemories.map((mem: any, index: number) => 
    `${index + 1}. Memory ID: ${mem.id}\n   Command ID: ${mem.command_id}\n   Data: ${JSON.stringify(mem.data).substring(0, 300)}...`
  ).join('\n') : 
  'No system analysis memories found'
}

=== SALES ANALYSIS ===
${salesMemories.length > 0 ? 
  salesMemories.map((mem: any, index: number) => 
    `${index + 1}. Memory ID: ${mem.id}\n   Command ID: ${mem.command_id}\n   Data: ${JSON.stringify(mem.data).substring(0, 300)}...`
  ).join('\n') : 
  'No sales analysis memories found'
}

=== SUPPORT ANALYSIS ===
${supportMemories.length > 0 ? 
  supportMemories.map((mem: any, index: number) => 
    `${index + 1}. Memory ID: ${mem.id}\n   Command ID: ${mem.command_id}\n   Data: ${JSON.stringify(mem.data).substring(0, 300)}...`
  ).join('\n') : 
  'No support analysis memories found'
}

=== GROWTH ANALYSIS ===
${growthMemories.length > 0 ? 
  growthMemories.map((mem: any, index: number) => 
    `${index + 1}. Memory ID: ${mem.id}\n   Command ID: ${mem.command_id}\n   Data: ${JSON.stringify(mem.data).substring(0, 300)}...`
  ).join('\n') : 
  'No growth analysis memories found'
}

RECENT STANDUP COMMANDS SUMMARY:
${memoriesData.standupCommands.slice(0, 10).map((cmd: any, index: number) => 
  `${index + 1}. ${cmd.task} - Status: ${cmd.status} - Created: ${cmd.created_at}`
).join('\n')}

EXECUTIVE SUMMARY REQUIREMENTS:
Please consolidate all the departmental analyses into a comprehensive daily standup report focusing on:

1. **Overall Business Health**: Cross-departmental insights and systemic issues
2. **Key Performance Indicators**: Critical metrics from system, sales, support, and growth
3. **Resource Allocation**: Team capacity and workload distribution across departments
4. **Strategic Priorities**: Action items and recommendations for immediate attention
5. **Risk Assessment**: Potential issues and bottlenecks identified across departments
6. **Growth Opportunities**: Identified opportunities for optimization and expansion
7. **Next Steps**: Concrete action plan for the next 24 hours
8. **Key actions for the human team to take**: based on the analysis and recommendations of the rest te ai team, that would make the best results for the company

IMPORTANT:
- Consider the team size, of the company, the swot, focus in account setup or campaign requirments, things the user can accomplish thorugh the day.
- Avoid complex tasks, that would make the user to do a lot of work, and not be able to do it. (you can mention it, but not make it as a priority)
- Avoid referening as human, use the team member or role when required.
- The summary should be in the language of the company.
- Make list of priorities for the day.
- Be concise and to the point. Try to generate tasks, not general recommendations.
- Avoid obvious things like, attend clients, be consice in which client, what task, what content or campaign.
- Be short, if only one task may be acomplished, just mention that one task that could make the rest easier or more effective.

CRITICAL FORMAT RULES FOR OUTPUT (MUST FOLLOW):
- Output must be plain text only. Do not use markdown, HTML, emojis, or code fences.
- Use ASCII characters only. Avoid smart quotes and special symbols.
- Use simple dashes '-' for bullet points when needed.
- Provide a single line beginning with 'Status:' followed by one of GREEN, YELLOW, or RED and a short reason (e.g., "Status: YELLOW - billing pending and setup incomplete").
- Provide priorities as short bullets starting with '- ' under 140 characters each.
- Avoid headings with symbols (#, **, etc.). Use simple sentences.

The summary should be executive-level, actionable, and provide clear visibility into the current state of operations across all business functions.`;
    
    // Crear el comando
    const command = CommandFactory.createCommand({
      task: 'daily standup executive summary',
      userId: agent.userId,
      agentId: agent.agentId,
      site_id: site_id,
      description: 'Consolidate all daily standup analyses into executive summary and actionable recommendations',
      targets: [
        {
          executive_summary: {
            analysis_type: "daily_standup_wrapup",
            consolidated_memories: memoriesData.memories,
            system_insights: systemMemories,
            sales_insights: salesMemories,
            support_insights: supportMemories,
            growth_insights: growthMemories,
            performance_metrics: {
              memories_analyzed: memoriesData.memoriesCount,
              commands_reviewed: memoriesData.commandsCount,
              departments_covered: [
                systemMemories.length > 0 ? 'system' : null,
                salesMemories.length > 0 ? 'sales' : null,
                supportMemories.length > 0 ? 'support' : null,
                growthMemories.length > 0 ? 'growth' : null
              ].filter(Boolean)
            }
          },
          subject: "Plain text key task or focus for the day (no markdown, emojis)",
          message: "Plain text list of key actions for the team to take. Start with a single 'Status: GREEN|YELLOW|RED - reason' line, followed by concise '- ' bullets for priorities. No markdown/emojis/HTML."
        }
      ],
      tools: [
       
      ],
      context: contextMessage,
      supervisor: [
        {
          agent_role: "executive_director",
          status: "not_initialized"
        }
      ]
    });
    
    // Enviar comando para procesamiento
    const internalCommandId = await commandService.submitCommand(command);
    console.log(`📝 Comando executive summary creado con ID: ${internalCommandId}`);
    
    // Esperar a que el comando se complete
    const { command: executedCommand, completed } = await waitForCommandCompletion(commandService, internalCommandId);
    
    if (!completed || !executedCommand) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'COMMAND_EXECUTION_FAILED', 
            message: 'The executive summary command did not complete successfully' 
          }
        },
        { status: 500 }
      );
    }
    
    // Extraer todos los resultados del análisis
    let summary = "Executive summary completed";
    let subject = "";
    let message = "";
    let executiveSummaryData = null;
    let allResults = [];
    
    if (executedCommand.results && Array.isArray(executedCommand.results)) {
      allResults = executedCommand.results;
      
      const analysisResults = executedCommand.results.find((r: any) => 
        r.executive_summary || r.consolidated_data || r.content || r.summary
      );
      
      if (analysisResults) {
        // Extraer executive_summary completo si existe
        if (analysisResults.executive_summary) {
          executiveSummaryData = analysisResults.executive_summary;
          
          // Extraer summary del executive_summary
          if (analysisResults.executive_summary.summary) {
            summary = analysisResults.executive_summary.summary;
          }
        } else if (analysisResults.consolidated_data && analysisResults.consolidated_data.summary) {
          summary = analysisResults.consolidated_data.summary;
        } else if (analysisResults.content) {
          summary = analysisResults.content;
        } else if (analysisResults.summary) {
          summary = analysisResults.summary;
        }
        
        // Buscar subject y message por separado en el nivel raíz de los resultados
        if (analysisResults.subject) {
          subject = analysisResults.subject;
        }
        if (analysisResults.message) {
          message = analysisResults.message;
        }
      }
    }
    
    // Asegurar que summary sea un string para evitar errores
    if (typeof summary !== 'string') {
      if (typeof summary === 'object' && summary !== null) {
        // Si es un objeto, intentar extraer información útil
        const summaryObj = summary as any;
        if (summaryObj.executive_summary || summaryObj.key_insights) {
          summary = summaryObj.executive_summary || summaryObj.key_insights;
        } else if (summaryObj.content) {
          summary = summaryObj.content;
        } else {
          summary = JSON.stringify(summary);
        }
      } else {
        summary = String(summary) || "Executive summary completed";
      }
    }
    
    console.log(`📊 Executive summary completado: ${summary.substring(0, 100)}...`);
    
    return NextResponse.json(
      { 
        success: true,
        data: { 
          command_id: executedCommand.id,
          summary: summary,
          subject: subject,
          message: message,
          analysis_type: "executive_wrapup",
          executive_summary: executiveSummaryData,
          results: allResults,
          consolidated_data: {
            memories_analyzed: memoriesData.memoriesCount,
            commands_reviewed: memoriesData.commandsCount,
            departments_covered: [
              systemMemories.length > 0 ? 'system' : null,
              salesMemories.length > 0 ? 'sales' : null,
              supportMemories.length > 0 ? 'support' : null,
              growthMemories.length > 0 ? 'growth' : null
            ].filter(Boolean),
            coverage_score: ((
              [systemMemories, salesMemories, supportMemories, growthMemories]
              .filter(arr => arr.length > 0).length / 4
            ) * 100).toFixed(0) + '%'
          }
        } 
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('Error en daily standup executive summary:', error);
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'An error occurred while processing the executive summary' } },
      { status: 500 }
    );
  }
} 