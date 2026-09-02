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
    const memoryKey = `daily_standup_growth_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    
    // Validar que command_id sea un UUID válido antes de guardarlo en la base de datos
    const validCommandId = commandId && isValidUUID(commandId) ? commandId : null;
    
    const memoryData = {
      id: memoryId,
      agent_id: agentId,
      user_id: userId,
      command_id: validCommandId,
      type: 'daily_standup_growth',
      key: memoryKey,
      data: {
        analysis_type: 'growth_performance_assessment',
        growth_analysis: analysisData,
        timestamp: new Date().toISOString(),
        site_id: siteId,
        command_id: commandId, // Mantener el ID original en data para referencia
        growth_metrics: {
          analysis_completed: true,
          experiments_reviewed: true,
          campaigns_assessed: true
        }
      },
      raw_data: JSON.stringify(analysisData),
      metadata: {
        source: 'daily_standup_growth',
        analysis_type: 'cmo_growth_analysis',
        importance: 'high',
        retention_policy: '7_days',
        original_command_id: commandId || null
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      access_count: 0,
      last_accessed: new Date().toISOString()
    };

    console.log(`💾 Guardando análisis de crecimiento en agent_memories para agente: ${agentId} (command_id: ${commandId})`);

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

    console.log(`✅ Memoria de crecimiento guardada con ID: ${data.id}`);
    
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

// Función para encontrar un agente de Growth Marketer activo para un sitio
async function findActiveGrowthAgent(siteId: string): Promise<{agentId: string, userId: string} | null> {
  try {
    if (!siteId || !isValidUUID(siteId)) {
      console.error(`❌ Invalid site_id for agent search: ${siteId}`);
      return null;
    }
    
    console.log(`🔍 Buscando agente de Growth Marketer activo para el sitio: ${siteId}`);
    
    const { data, error } = await supabaseAdmin
      .from('agents')
      .select('id, user_id')
      .eq('site_id', siteId)
      .eq('role', 'Growth Marketer')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1);
    
    if (error) {
      console.error('Error al buscar agente de Growth Marketer:', error);
      return null;
    }
    
    if (!data || data.length === 0) {
      console.log(`⚠️ No se encontró ningún agente de Growth Marketer activo para el sitio: ${siteId}`);
      return null;
    }
    
    console.log(`✅ Agente de Growth Marketer encontrado: ${data[0].id} (user_id: ${data[0].user_id})`);
    return {
      agentId: data[0].id,
      userId: data[0].user_id
    };
  } catch (error) {
    console.error('Error al buscar agente de Growth Marketer:', error);
    return null;
  }
}

// Función para obtener datos de crecimiento
async function getGrowthData(siteId: string) {
  try {
    console.log(`📈 Obteniendo datos de crecimiento para site_id: ${siteId}`);
    
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    
    // Obtener contenidos recientes
    const { data: contentData, error: contentError } = await supabaseAdmin
      .from('content')
      .select('*')
      .eq('site_id', siteId)
      .gte('created_at', yesterday)
      .order('created_at', { ascending: false })
      .limit(20);
    
    if (contentError) {
      console.error('Error al obtener contenidos:', contentError);
    }
    
    // Obtener experimentos activos
    const { data: experiments, error: experimentsError } = await supabaseAdmin
      .from('experiments')
      .select('*')
      .eq('site_id', siteId)
      .in('status', ['active', 'running', 'analyzing'])
      .order('created_at', { ascending: false })
      .limit(15);
    
    if (experimentsError) {
      console.error('Error al obtener experimentos:', experimentsError);
    }
    
    // Obtener campañas de crecimiento
    const { data: campaigns, error: campaignsError } = await supabaseAdmin
      .from('campaigns')
      .select('*')
      .eq('site_id', siteId)
      .in('status', ['active', 'pending'])
      .order('created_at', { ascending: false })
      .limit(10);
    
    if (campaignsError) {
      console.error('Error al obtener campañas:', campaignsError);
    }
    
    // Obtener comandos de growth activos
    const { data: growthCommands, error: commandsError } = await supabaseAdmin
      .from('commands')
      .select('*')
      .eq('site_id', siteId)
      .in('task', ['content generation', 'campaign analysis', 'growth strategy'])
      .in('status', ['pending', 'running'])
      .order('created_at', { ascending: false })
      .limit(20);
    
    if (commandsError) {
      console.error('Error al obtener comandos de growth:', commandsError);
    }
    
    // Obtener análisis de sitio recientes
    const { data: siteAnalysis, error: analysisError } = await supabaseAdmin
      .from('analysis')
      .select('*')
      .eq('site_id', siteId)
      .gte('created_at', yesterday)
      .order('created_at', { ascending: false })
      .limit(5);
    
    if (analysisError) {
      console.error('Error al obtener análisis de sitio:', analysisError);
    }
    
    return {
      contentData: contentData || [],
      experiments: experiments || [],
      campaigns: campaigns || [],
      growthCommands: growthCommands || [],
      siteAnalysis: siteAnalysis || [],
      contentCount: contentData?.length || 0,
      experimentsCount: experiments?.length || 0,
      campaignsCount: campaigns?.length || 0,
      activeCommandsCount: growthCommands?.length || 0,
      analysisCount: siteAnalysis?.length || 0
    };
  } catch (error) {
    console.error('Error al obtener datos de crecimiento:', error);
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
    
    // Buscar agente de Growth Marketer activo
    const agent = await findActiveGrowthAgent(site_id);
    if (!agent) {
      return NextResponse.json(
        { success: false, error: { code: 'AGENT_NOT_FOUND', message: 'No active Growth Marketer agent found for this site' } },
        { status: 404 }
      );
    }
    
    console.log(`🤖 Iniciando daily standup growth para agente: ${agent.agentId}, usuario: ${agent.userId}, sitio: ${site_id}`);
    
    // Obtener datos de crecimiento
    const growthData = await getGrowthData(site_id);
    
    if (!growthData) {
      return NextResponse.json(
        { success: false, error: { code: 'DATA_ERROR', message: 'Could not retrieve growth data' } },
        { status: 500 }
      );
    }
    
    // Preparar contexto con los datos de crecimiento
    const contextMessage = `Daily StandUp - Growth Analysis for Site: ${site_id}
    
Growth Performance (Last 24h):
- New Content Created: ${growthData.contentCount}
- Active Experiments: ${growthData.experimentsCount}
- Running Campaigns: ${growthData.campaignsCount}
- Active Growth Commands: ${growthData.activeCommandsCount}
- Site Analysis Reports: ${growthData.analysisCount}

Recent Content Summary:
${growthData.contentData.slice(0, 10).map((content: any, index: number) => 
  `${index + 1}. ${content.title || 'Untitled'} - Type: ${content.type || 'Article'} - Status: ${content.status || 'Draft'}`
).join('\n')}

Active Experiments:
${growthData.experiments.slice(0, 8).map((exp: any, index: number) => 
  `${index + 1}. ${exp.name || 'Unnamed'} - Type: ${exp.type || 'A/B Test'} - Status: ${exp.status} - Progress: ${exp.progress || 0}%`
).join('\n')}

Running Campaigns:
${growthData.campaigns.slice(0, 5).map((campaign: any, index: number) => 
  `${index + 1}. ${campaign.name || 'Unnamed'} - Type: ${campaign.type || 'Marketing'} - Status: ${campaign.status} - Budget: ${campaign.budget || 'N/A'}`
).join('\n')}

Growth Team Coordination:
- Active Commands: ${growthData.activeCommandsCount}
- Content Pipeline: ${growthData.contentCount > 5 ? 'Strong' : growthData.contentCount > 2 ? 'Moderate' : 'Low'}
- Experiment Velocity: ${growthData.experimentsCount > 3 ? 'High' : growthData.experimentsCount > 1 ? 'Medium' : 'Low'}

Please analyze these growth aspects and provide a comprehensive summary focusing on:
1. Content creation performance and quality
2. Experiment execution and results analysis
3. Campaign effectiveness and ROI
4. Growth strategy alignment and optimization opportunities`;
    
    // Crear el comando
    const command = CommandFactory.createCommand({
      task: 'daily standup growth analysis',
      userId: agent.userId,
      agentId: agent.agentId,
      agentRole: 'Growth Marketer',
      site_id: site_id,
      description: 'Analyze growth performance, content, experiments, and campaigns for daily standup report',
      targets: [
        {
          growth_analysis: {
            analysis_type: "daily_standup_growth",
            content_data: growthData.contentData,
            experiments_data: growthData.experiments,
            campaigns_data: growthData.campaigns,
            site_analysis_data: growthData.siteAnalysis,
            performance_metrics: {
              content_count: growthData.contentCount,
              experiments_count: growthData.experimentsCount,
              campaigns_count: growthData.campaignsCount,
              active_commands_count: growthData.activeCommandsCount,
              analysis_count: growthData.analysisCount
            }
          }
        }
      ],
      tools: [
        
      ],
      context: contextMessage,
      supervisor: [
        {
          agent_role: "growth_director",
          status: "not_initialized"
        }
      ]
    });
    
    // Enviar comando para procesamiento
    const internalCommandId = await commandService.submitCommand(command);
    console.log(`📝 Comando growth analysis creado con ID: ${internalCommandId}`);
    
    // Esperar a que el comando se complete
    const { command: executedCommand, completed } = await waitForCommandCompletion(commandService, internalCommandId);
    
    if (!completed || !executedCommand) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'COMMAND_EXECUTION_FAILED', 
            message: 'The growth analysis command did not complete successfully' 
          }
        },
        { status: 500 }
      );
    }
    
    // Extraer el resumen del análisis
    let summary = "Growth analysis completed";
    
    if (executedCommand.results && Array.isArray(executedCommand.results)) {
      const analysisResults = executedCommand.results.find((r: any) => 
        r.growth_analysis || r.content || r.summary
      );
      
      if (analysisResults) {
        if (analysisResults.growth_analysis && analysisResults.growth_analysis.summary) {
          summary = analysisResults.growth_analysis.summary;
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
        if (summaryObj.growth_metrics || summaryObj.performance_analysis) {
          summary = summaryObj.growth_metrics || summaryObj.performance_analysis;
        } else if (summaryObj.content) {
          summary = summaryObj.content;
        } else {
          summary = JSON.stringify(summary);
        }
      } else {
        summary = String(summary) || "Growth analysis completed";
      }
    }
    
    console.log(`📈 Growth analysis completado: ${summary.substring(0, 100)}...`);
    
    // Extraer el análisis completo para guardar en memoria
    let growthAnalysis = null;
    if (executedCommand.results && Array.isArray(executedCommand.results)) {
      const analysisResults = executedCommand.results.find((r: any) => 
        r.growth_analysis
      );
      
      if (analysisResults && analysisResults.growth_analysis) {
        growthAnalysis = analysisResults.growth_analysis;
      }
    }
    
    // Guardar en agent_memories si tenemos análisis
    if (growthAnalysis) {
      const memoryResult = await saveToAgentMemory(agent.agentId, agent.userId, executedCommand.id, growthAnalysis, site_id);
      
      if (!memoryResult.success) {
        console.warn(`⚠️ No se pudo guardar memoria de crecimiento: ${memoryResult.error}`);
      }
    }
    
    return NextResponse.json(
      { 
        success: true, 
        data: { 
          command_id: executedCommand.id,
          summary: summary,
          analysis_type: "growth",
          growth_data: {
            content_count: growthData.contentCount,
            experiments_count: growthData.experimentsCount,
            campaigns_count: growthData.campaignsCount,
            active_commands_count: growthData.activeCommandsCount,
            analysis_count: growthData.analysisCount
          }
        } 
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('Error en daily standup growth analysis:', error);
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'An error occurred while processing the growth analysis' } },
      { status: 500 }
    );
  }
} 