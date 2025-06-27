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
    const memoryKey = `daily_standup_system_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    
    // Validar que command_id sea un UUID válido antes de guardarlo en la base de datos
    const validCommandId = commandId && isValidUUID(commandId) ? commandId : null;
    
    const memoryData = {
      id: memoryId,
      agent_id: agentId,
      user_id: userId,
      command_id: validCommandId,
      type: 'daily_standup_system',
      key: memoryKey,
      data: {
        analysis_type: 'system_health_assessment',
        strategic_analysis: analysisData,
        timestamp: new Date().toISOString(),
        site_id: siteId,
        command_id: commandId, // Mantener el ID original en data para referencia
        system_metrics: {
          analysis_completed: true,
          recommendations_generated: true,
          health_status: analysisData?.health_status || 'analyzed'
        }
      },
      raw_data: JSON.stringify(analysisData),
      metadata: {
        source: 'daily_standup_system',
        analysis_type: 'cmo_system_analysis',
        importance: 'high',
        retention_policy: '7_days',
        original_command_id: commandId || null
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      access_count: 0,
      last_accessed: new Date().toISOString()
    };

    console.log(`💾 Guardando análisis del sistema en agent_memories para agente: ${agentId} (command_id: ${commandId})`);

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

    console.log(`✅ Memoria del sistema guardada con ID: ${data.id}`);
    
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

// Función para obtener datos del sistema
async function getSystemData(siteId: string) {
  try {
    console.log(`📊 Obteniendo datos del sistema para site_id: ${siteId}`);
    
    // Obtener configuraciones del sitio
    const { data: siteConfig, error: siteError } = await supabaseAdmin
      .from('sites')
      .select('*')
      .eq('id', siteId)
      .single();
    
    if (siteError) {
      console.error('Error al obtener configuración del sitio:', siteError);
    }
    
    // Obtener settings del sitio para análisis de configuración
    const { data: siteSettings, error: settingsError } = await supabaseAdmin
      .from('settings')
      .select('*')
      .eq('site_id', siteId)
      .order('created_at', { ascending: false });
    
    if (settingsError) {
      console.error('Error al obtener settings del sitio:', settingsError);
    }
    
    // Obtener información de billing
    const { data: billingData, error: billingError } = await supabaseAdmin
      .from('subscriptions')
      .select('*')
      .eq('site_id', siteId)
      .order('created_at', { ascending: false })
      .limit(1);
    
    if (billingError) {
      console.error('Error al obtener datos de billing:', billingError);
    }
    
    // Obtener métricas básicas del sistema
    const { data: systemMetrics, error: metricsError } = await supabaseAdmin
      .from('session_events')
      .select('*')
      .eq('site_id', siteId)
      .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()) // Últimas 24 horas
      .order('created_at', { ascending: false });
    
    if (metricsError) {
      console.error('Error al obtener métricas del sistema:', metricsError);
    }
    
    return {
      siteConfig: siteConfig || null,
      siteSettings: siteSettings || [],
      billingData: billingData?.[0] || null,
      systemMetrics: systemMetrics || [],
      metricsCount: systemMetrics?.length || 0,
      settingsCount: siteSettings?.length || 0
    };
  } catch (error) {
    console.error('Error al obtener datos del sistema:', error);
    return null;
  }
}

// Función para obtener el UUID de la BD usando el ID interno
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
async function waitForCommandCompletion(commandService: any, commandId: string, maxAttempts = 100, delayMs = 1000) {
  let executedCommand = null;
  let attempts = 0;
  let dbUuid: string | null = null;
  
  console.log(`⏳ Esperando a que se complete el comando ${commandId}...`);
  
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
    
    console.log(`🤖 Iniciando daily standup system para agente: ${agent.agentId}, usuario: ${agent.userId}, sitio: ${site_id}`);
    
    // Obtener datos del sistema
    const systemData = await getSystemData(site_id);
    
    if (!systemData) {
      return NextResponse.json(
        { success: false, error: { code: 'DATA_ERROR', message: 'Could not retrieve system data' } },
        { status: 500 }
      );
    }
    
    // Preparar contexto con los datos del sistema
    const contextMessage = `Daily StandUp - System Analysis for Site: ${site_id}

TASK: Conduct a comprehensive human analysis of our system health and provide strategic recommendations for optimization and growth.

As our CMO, please analyze the current system state and provide your expert assessment:

Available Data Sources:
- Site configuration and current settings
- Billing and subscription information  
- Recent system activity and user engagement
- Configuration completeness across all channels

REQUIRED ANALYSIS & RECOMMENDATIONS:

1. SYSTEM HEALTH ASSESSMENT
   - What's your overall assessment of our system health? (Green/Yellow/Red and why)
   - What are the most critical issues you've identified?
   - How would you rate our current operational stability?

2. STRATEGIC BILLING REVIEW
   - How healthy is our subscription and billing status?
   - Are there any financial concerns or optimization opportunities?
   - What billing-related actions should we prioritize?

3. CONFIGURATION & SETUP ANALYSIS
   - How complete is our system configuration from a business perspective?
   - What critical gaps are preventing us from maximizing performance?
   - Which configuration improvements would drive the most impact?

4. ONBOARDING & ACTIVATION STATUS
   - What percentage of our setup do you estimate is complete?
   - What are the biggest blockers preventing full system activation?
   - What would you prioritize to improve user onboarding experience?

5. STRATEGIC ACTION RECOMMENDATIONS
   - What are your top 3 strategic priorities for this week?
   - Which quick wins could we implement immediately?
   - What configuration changes would you recommend to drive growth?

6. RISK & OPPORTUNITY ASSESSMENT
   - What risks do you see in our current system state?
   - What opportunities are we missing due to incomplete setup?
   - What preventive measures should we implement?

Please provide your analysis in a conversational, strategic format as if you're briefing the executive team. Focus on business impact, user experience, and growth opportunities rather than technical details.

IMPORTANT:
- The summary should be in the language of the company.

Raw System Data:
${JSON.stringify({
  siteConfig: systemData.siteConfig,
  settingsData: systemData.siteSettings,
  billingInfo: systemData.billingData,
  activityMetrics: {
    recentEvents: systemData.metricsCount,
    settingsCount: systemData.settingsCount
  }
}, null, 2)}`;
    
    // Crear el comando
    const command = CommandFactory.createCommand({
      task: 'daily standup system analysis',
      userId: agent.userId,
      agentId: agent.agentId,
      site_id: site_id,
      description: 'Analyze system settings, billing status, and basic system metrics for daily standup report',
      targets: [
        {
          strategic_system_analysis: {
            analysis_type: "cmo_daily_standup_strategic_review",
            business_assessment: "comprehensive system health and_optimization_analysis",
            focus_areas: [ 
                "list with activities to do in order to finish the account setup"
            ],
            output_format: "executive_briefing_with_actionable_insights",
            perspective: "cmo_strategic_business_analysis"
          }
        }
      ],
      tools: [
        
      ],
      context: contextMessage,
             supervisor: [
         {
           agent_role: "system_administrator",
           status: "not_initialized"
         }
       ]
    });
    
    // Enviar comando para procesamiento
    const internalCommandId = await commandService.submitCommand(command);
    console.log(`📝 Comando system analysis creado con ID: ${internalCommandId}`);
    
    // Obtener el UUID inicial si está disponible (antes de esperar)
    let initialDbUuid: string | null = null;
    try {
      const tempCommand = await commandService.getCommandById(internalCommandId);
      if (tempCommand?.metadata?.dbUuid && isValidUUID(tempCommand.metadata.dbUuid)) {
        initialDbUuid = tempCommand.metadata.dbUuid;
        console.log(`🔑 UUID inicial obtenido: ${initialDbUuid}`);
      }
    } catch (err) {
      console.log('No se pudo obtener UUID inicial');
    }

    // Esperar a que el comando se complete
    const { command: executedCommand, dbUuid, completed } = await waitForCommandCompletion(commandService, internalCommandId);
    
    if (!completed || !executedCommand) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'COMMAND_EXECUTION_FAILED', 
            message: 'The system analysis command did not complete successfully' 
          }
        },
        { status: 500 }
      );
    }
    
    // Determinar el UUID efectivo de la base de datos
    const effectiveDbUuid = (dbUuid && isValidUUID(dbUuid)) ? dbUuid : initialDbUuid;
    
    // Extraer el análisis estratégico completo de los resultados
    let strategicAnalysis = null;
    
    if (executedCommand.results && Array.isArray(executedCommand.results)) {
      const analysisResults = executedCommand.results.find((r: any) => 
        r.strategic_system_analysis
      );
      
      if (analysisResults && analysisResults.strategic_system_analysis) {
        strategicAnalysis = analysisResults.strategic_system_analysis;
        console.log(`📊 Strategic analysis extraído exitosamente`);
      }
    }
    
    // Si no encontramos el análisis estratégico, devolver error
    if (!strategicAnalysis) {
      console.error('❌ No se pudo extraer el análisis estratégico de los resultados');
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'ANALYSIS_EXTRACTION_FAILED', 
            message: 'Could not extract strategic analysis from command results' 
          }
        },
        { status: 500 }
      );
    }
    
    console.log(`📊 Strategic analysis completado para comando: ${effectiveDbUuid || internalCommandId}`);
    
    // Guardar en agent_memories
    const memoryResult = await saveToAgentMemory(agent.agentId, agent.userId, effectiveDbUuid || internalCommandId, strategicAnalysis, site_id);
    
    if (!memoryResult.success) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'MEMORY_SAVE_FAILED', 
            message: memoryResult.error 
          }
        },
        { status: 500 }
      );
    }
    
    return NextResponse.json(
      { 
        success: true, 
        data: { 
          command_id: effectiveDbUuid || internalCommandId,
          strategic_analysis: strategicAnalysis,
          analysis_type: "system",
          system_data: {
            site_status: systemData.siteConfig?.status,
            billing_status: systemData.billingData?.status,
            events_count: systemData.metricsCount,
            settings_count: systemData.settingsCount
          }
        } 
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('Error en daily standup system analysis:', error);
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'An error occurred while processing the system analysis' } },
      { status: 500 }
    );
  }
} 