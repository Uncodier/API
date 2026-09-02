import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Función para guardar en agent_memories
async function saveToAgentMemory(agentId: string, userId: string, commandId: string, analysisData: any, siteId: string): Promise<{success: boolean, memoryId?: string, error?: string}> {
  try {
    const memoryId = uuidv4();
    const memoryKey = `daily_standup_sales_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    
    // Validar que command_id sea un UUID válido antes de guardarlo en la base de datos
    const validCommandId = commandId && isValidUUID(commandId) ? commandId : null;
    
    const memoryData = {
      id: memoryId,
      agent_id: agentId,
      user_id: userId,
      command_id: validCommandId,
      type: 'daily_standup_sales',
      key: memoryKey,
      data: {
        analysis_type: 'sales_performance_assessment',
        sales_analysis: analysisData,
        timestamp: new Date().toISOString(),
        site_id: siteId,
        command_id: commandId, // Mantener el ID original en data para referencia
        sales_metrics: {
          analysis_completed: true,
          performance_reviewed: true,
          team_coordination_assessed: true
        }
      },
      raw_data: JSON.stringify(analysisData),
      metadata: {
        source: 'daily_standup_sales',
        analysis_type: 'cmo_sales_analysis',
        importance: 'high',
        retention_policy: '7_days',
        original_command_id: commandId || null
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      access_count: 0,
      last_accessed: new Date().toISOString()
    };

    console.log(`💾 Guardando análisis de ventas en agent_memories para agente: ${agentId} (command_id: ${commandId})`);

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

    console.log(`✅ Memoria de ventas guardada con ID: ${data.id}`);
    
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
async function findActiveCmoAgent(siteId: string): Promise<{agentId: string, userId: string, agentData: any} | null> {
  try {
    if (!siteId || !isValidUUID(siteId)) {
      console.error(`❌ Invalid site_id for agent search: ${siteId}`);
      return null;
    }
    
    console.log(`🔍 Buscando agente de Sales/CRM activo para el sitio: ${siteId}`);
    
    const { data, error } = await supabaseAdmin
      .from('agents')
      .select('id, user_id, status')
      .eq('site_id', siteId)
      .eq('role', 'Sales/CRM Specialist')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1);
    
    if (error) {
      console.error('Error al buscar agente de Sales/CRM:', error);
      return null;
    }
    
    if (!data || data.length === 0) {
      console.log(`⚠️ No se encontró ningún agente de Sales/CRM activo para el sitio: ${siteId}`);
      return null;
    }
    
    console.log(`✅ Agente de Sales/CRM encontrado: ${data[0].id} (user_id: ${data[0].user_id})`);
    return {
      agentId: data[0].id,
      userId: data[0].user_id,
      agentData: data[0]
    };
  } catch (error) {
    console.error('Error al buscar agente de Sales/CRM:', error);
    return null;
  }
}

// Función para obtener datos de ventas
async function getSalesData(siteId: string, salesAgent?: any) {
  try {
    console.log(`💰 Obteniendo datos de ventas para site_id: ${siteId}`);
    
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    // Bordes del día previo (UTC): [yesterdayStart, todayStart)
    const now = new Date();
    const todayStartDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
    const yesterdayStartDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 0, 0, 0, 0));
    const startTs = yesterdayStartDate.getTime();
    const endTs = todayStartDate.getTime();
    
    // Obtener leads creados ayer con status 'new'
    const { data: newLeads, error: leadsError } = await supabaseAdmin
      .from('leads')
      .select('*')
      .eq('site_id', siteId)
      .eq('status', 'new')
      .gte('created_at', yesterday)
      .order('created_at', { ascending: false });
    
    if (leadsError) {
      console.error('Error al obtener leads:', leadsError);
    }
    
    // Obtener comandos de ventas activos
    const { data: salesCommands, error: commandsError } = await supabaseAdmin
      .from('commands')
      .select('*')
      .eq('site_id', siteId)
      .in('task', ['lead generation', 'lead follow up', 'lead research'])
      .in('status', ['pending', 'running'])
      .order('created_at', { ascending: false })
      .limit(20);
    
    if (commandsError) {
      console.error('Error al obtener comandos de ventas:', commandsError);
    }
    
    // Obtener conversaciones de ventas recientes
    const { data: salesConversations, error: conversationsError } = await supabaseAdmin
      .from('conversations')
      .select('*, messages(*)')
      .eq('site_id', siteId)
      .not('lead_id', 'is', null)
      .gte('updated_at', yesterday)
      .order('updated_at', { ascending: false })
      .limit(10);
    
    if (conversationsError) {
      console.error('Error al obtener conversaciones de ventas:', conversationsError);
    }

    // Extraer mensajes nuevos (últimas 24h) desde las conversaciones recientes
    const newMessages = (salesConversations || [])
      .flatMap((conv: any) => Array.isArray(conv?.messages) ? conv.messages : [])
      .filter((m: any) => {
        if (!m?.created_at) return false;
        const ts = new Date(m.created_at).getTime();
        return Number.isFinite(ts) && ts >= startTs && ts < endTs; // solo día previo
      });

    return {
      newLeads: newLeads || [],
      salesCommands: salesCommands || [],
      salesConversations: salesConversations || [],
      newMessages: newMessages || [],
      salesAgent: salesAgent || null,
      leadsCount: newLeads?.length || 0,
      activeCommandsCount: salesCommands?.length || 0,
      conversationsCount: salesConversations?.length || 0,
      newMessagesCount: newMessages?.length || 0
    };
  } catch (error) {
    console.error('Error al obtener datos de ventas:', error);
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
    
    // Buscar agente de Sales/CRM activo
    const agent = await findActiveCmoAgent(site_id);
    if (!agent) {
      return NextResponse.json(
        { success: false, error: { code: 'AGENT_NOT_FOUND', message: 'No active Sales/CRM agent found for this site' } },
        { status: 404 }
      );
    }
    
    console.log(`🤖 Iniciando daily standup sales para agente: ${agent.agentId}, usuario: ${agent.userId}, sitio: ${site_id}`);
    
    // Obtener datos de ventas
    const salesData = await getSalesData(site_id, agent.agentData);
    
    if (!salesData) {
      return NextResponse.json(
        { success: false, error: { code: 'DATA_ERROR', message: 'Could not retrieve sales data' } },
        { status: 500 }
      );
    }
    
    // Preparar contexto con los datos de ventas
    const contextMessage = `Daily StandUp - Sales Analysis for Site: ${site_id}
    
Sales Performance (Last 24h):
- New Leads Created: ${salesData.leadsCount}
- Active Sales Commands: ${salesData.activeCommandsCount}
- Sales Conversations: ${salesData.conversationsCount}
- New Messages Added: ${salesData.newMessagesCount}
- Sales Agent Status: ${salesData.salesAgent ? 'Active' : 'Not Found'}

New Leads (status = new) Summary:
${salesData.newLeads.map((lead: any, index: number) => 
  `${index + 1}. ${lead.name || 'Unknown'} (${lead.email || 'No email'}) - ${lead.status || 'New'}`
).join('\n')}

New Messages Summary (Previous day, UTC):
${(salesData.newMessages || []).slice(0, 10).map((m: any, index: number) => {
  const content = (m?.content || '').replace(/\n/g, ' ').slice(0, 120);
  return `${index + 1}. ${m?.role || 'unknown'} - ${content}${content.length === 120 ? '…' : ''} (Conv: ${m?.conversation_id || 'n/a'})`;
}).join('\n')}

Active Sales Commands:
${salesData.salesCommands.map((cmd: any, index: number) => 
  `${index + 1}. ${cmd.task} - Status: ${cmd.status} (Created: ${cmd.created_at})`
).join('\n')}

Sales Team Coordination:
- Sales Agent ID: ${salesData.salesAgent?.id || 'No active agent'}
- Pending Follow-ups: ${salesData.activeCommandsCount}

Please analyze these sales aspects and provide a comprehensive summary focusing on:
1. Lead generation performance and quality
2. Sales pipeline health and active opportunities
3. Sales team coordination and capacity
4. Recommendations for sales optimization

Additionally, include a brief summary of the newly added leads (status = new) and the newly added messages (last 24h).`;
    
    // Crear el comando
    const command = CommandFactory.createCommand({
      task: 'daily standup sales analysis',
      userId: agent.userId,
      agentId: agent.agentId,
      agentRole: 'Sales/CRM Specialist',
      site_id: site_id,
      description: 'Analyze sales performance, leads, and coordinate with sales team for daily standup report',
      targets: [
        {
          sales_analysis: {
            analysis_type: "daily_standup_sales",
            leads_data: salesData.newLeads,
            sales_commands: salesData.salesCommands,
            sales_conversations: salesData.salesConversations,
            new_messages: salesData.newMessages,
            performance_metrics: {
              new_leads_count: salesData.leadsCount,
              active_commands_count: salesData.activeCommandsCount,
              conversations_count: salesData.conversationsCount,
              new_messages_count: salesData.newMessagesCount
            }
          }
        }
      ],
      tools: [
       
      ],
      context: contextMessage,
      supervisor: [
        {
          agent_role: "sales_director",
          status: "not_initialized"
        }
      ]
    });
    
    // Enviar comando para procesamiento
    const internalCommandId = await commandService.submitCommand(command);
    console.log(`📝 Comando sales analysis creado con ID: ${internalCommandId}`);
    
    // Esperar a que el comando se complete
    const { command: executedCommand, completed } = await waitForCommandCompletion(commandService, internalCommandId);
    
    if (!completed || !executedCommand) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'COMMAND_EXECUTION_FAILED', 
            message: 'The sales analysis command did not complete successfully' 
          }
        },
        { status: 500 }
      );
    }
    
    // Extraer el resumen del análisis
    let summary = "Sales analysis completed";
    
    if (executedCommand.results && Array.isArray(executedCommand.results)) {
      const analysisResults = executedCommand.results.find((r: any) => 
        r.sales_analysis || r.content || r.summary
      );
      
      if (analysisResults) {
        if (analysisResults.sales_analysis && analysisResults.sales_analysis.summary) {
          summary = analysisResults.sales_analysis.summary;
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
        if (summaryObj.sales_team_coordination_and_capacity) {
          summary = summaryObj.sales_team_coordination_and_capacity;
        } else if (summaryObj.content) {
          summary = summaryObj.content;
        } else {
          summary = JSON.stringify(summary);
        }
      } else {
        summary = String(summary) || "Sales analysis completed";
      }
    }
    
    console.log(`💰 Sales analysis completado: ${summary.substring(0, 100)}...`);
    
    // Extraer el análisis completo para guardar en memoria
    let salesAnalysis = null;
    if (executedCommand.results && Array.isArray(executedCommand.results)) {
      const analysisResults = executedCommand.results.find((r: any) => 
        r.sales_analysis
      );
      
      if (analysisResults && analysisResults.sales_analysis) {
        salesAnalysis = analysisResults.sales_analysis;
      }
    }
    
    // Guardar en agent_memories si tenemos análisis
    if (salesAnalysis) {
      const memoryResult = await saveToAgentMemory(agent.agentId, agent.userId, executedCommand.id, salesAnalysis, site_id);
      
      if (!memoryResult.success) {
        console.warn(`⚠️ No se pudo guardar memoria de ventas: ${memoryResult.error}`);
      }
    }
    
    return NextResponse.json(
      { 
        success: true, 
        data: { 
          command_id: executedCommand.id,
          summary: summary,
          analysis_type: "sales",
          sales_data: {
            new_leads_count: salesData.leadsCount,
            active_commands_count: salesData.activeCommandsCount,
            conversations_count: salesData.conversationsCount,
            new_messages_count: salesData.newMessagesCount,
            sales_agent_active: !!salesData.salesAgent
          }
        } 
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('Error en daily standup sales analysis:', error);
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'An error occurred while processing the sales analysis' } },
      { status: 500 }
    );
  }
} 