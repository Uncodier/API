import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getWrapUpInputs } from '@/lib/services/wrapUpData';
import { buildWrapUpContext } from '@/lib/prompts/dailyStandupWrapUpContext';

// Increase function execution limit for Vercel/Next.js to 200 seconds
export const maxDuration = 200;

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
    // Obtener comandos completados del daily standup (últimas 12h) para este sitio
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
    // Resolver lista de command_ids a usar (entrada del cliente o recientes del sitio)
    let commandIdsToUse: string[] = Array.isArray(commandIds) ? commandIds.filter(id => typeof id === 'string') : [];
    if (commandIdsToUse.length === 0 && Array.isArray(standupCommands) && standupCommands.length > 0) {
      commandIdsToUse = standupCommands.map((c: any) => c.id).filter((id: any) => typeof id === 'string');
    }

    let memories: any[] = [];
    if (commandIdsToUse.length > 0) {
      console.log(`🧠 Obteniendo memorias del agente para command_ids: ${commandIdsToUse.join(', ')}`);
      const { data, error } = await supabaseAdmin
        .from('agent_memories')
        .select('*')
        .in('command_id', commandIdsToUse)
        .in('type', ['daily_standup_system', 'daily_standup_sales', 'daily_standup_support', 'daily_standup_growth'])
        .order('created_at', { ascending: false });
      if (error) {
        console.error('Error al obtener memorias del agente:', error);
        return null;
      }
      memories = data || [];
    } else {
      console.log('ℹ️ No hay command_ids para buscar memorias; se devolverán memorias vacías.');
    }

    return {
      memories,
      standupCommands: standupCommands || [],
      memoriesCount: memories?.length || 0,
      commandsCount: standupCommands?.length || 0
    };
  } catch (error) {
    console.error('Error al obtener memorias del agente:', error);
    return null;
  }
}

// Build compact leads/messages summary from recent sales memories (if available)
function buildLeadsAndMessagesSummaryFromSalesMemories(salesMemories: any[]) {
  if (!Array.isArray(salesMemories) || salesMemories.length === 0) return null;
  // Prefer most recent memory
  const mem = salesMemories[0];
  const sa = mem?.data?.sales_analysis || null;
  if (!sa || typeof sa !== 'object') return null;

  const newLeadsCount = typeof sa?.performance_metrics?.new_leads_count === 'number'
    ? sa.performance_metrics.new_leads_count
    : (Array.isArray(sa?.leads_data) ? sa.leads_data.length : undefined);

  const newMessagesCount = typeof sa?.performance_metrics?.new_messages_count === 'number'
    ? sa.performance_metrics.new_messages_count
    : (Array.isArray(sa?.new_messages) ? sa.new_messages.length : undefined);

  const conversationsCount = typeof sa?.performance_metrics?.conversations_count === 'number'
    ? sa.performance_metrics.conversations_count
    : (Array.isArray(sa?.sales_conversations) ? sa.sales_conversations.length : undefined);

  // Estimate contacted leads as unique leads that had conversations captured
  let contactedLeadsCount: number | undefined = undefined;
  if (Array.isArray(sa?.sales_conversations)) {
    const uniqueLeadIds = new Set<string>();
    for (const c of sa.sales_conversations) {
      const leadId = (c && (c.lead_id || c.leadId)) as string | undefined;
      if (leadId) uniqueLeadIds.add(leadId);
    }
    contactedLeadsCount = uniqueLeadIds.size;
  }

  const topNewLeads = Array.isArray(sa?.leads_data)
    ? sa.leads_data.slice(0, 5).map((lead: any) => ({
        id: lead?.id || null,
        name: lead?.name || 'Unknown',
        email: lead?.email || null,
        status: lead?.status || null
      }))
    : [];

  const recentMessages = Array.isArray(sa?.new_messages)
    ? sa.new_messages.slice(0, 5).map((m: any) => ({
        conversation_id: m?.conversation_id || null,
        role: m?.role || null,
        content_preview: typeof m?.content === 'string' ? m.content.replace(/\n/g, ' ').slice(0, 120) : null
      }))
    : [];

  const summary = {
    time_window: 'previous_day_utc',
    new_leads_count: typeof newLeadsCount === 'number' ? newLeadsCount : 0,
    contacted_leads_count: typeof contactedLeadsCount === 'number' ? contactedLeadsCount : 0,
    new_messages_count: typeof newMessagesCount === 'number' ? newMessagesCount : 0,
    conversations_count: typeof conversationsCount === 'number' ? conversationsCount : 0,
    top_new_leads: topNewLeads,
    recent_messages: recentMessages
  };

  return summary;
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
    const { site_id, command_ids, command_id } = body;
    
    if (!site_id || !isValidUUID(site_id)) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'site_id is required and must be a valid UUID' } },
        { status: 400 }
      );
    }
    
    // Validar command_id(s) si se proporcionan (ambos soportados, opcionales)
    let validCommandIds: string[] = [];
    if (command_id && typeof command_id === 'string' && isValidUUID(command_id)) {
      validCommandIds.push(command_id);
    }
    if (command_ids && Array.isArray(command_ids)) {
      const extra = command_ids.filter((id: string) => isValidUUID(id));
      validCommandIds.push(...extra);
      console.log(`📋 Command IDs proporcionados: ${validCommandIds.length} válidos`);
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
    
    const leadsAndMessagesSummary = buildLeadsAndMessagesSummaryFromSalesMemories(salesMemories);

    // Obtener datasets operativos requeridos para wrap-up
    const wrapUpInputs = await getWrapUpInputs(site_id);
    if (!wrapUpInputs) {
      return NextResponse.json(
        { success: false, error: { code: 'DATA_ERROR', message: 'Could not retrieve wrap-up inputs' } },
        { status: 500 }
      );
    }

    const contextMessage = buildWrapUpContext({
      siteId: site_id,
      systemMemories,
      salesMemories,
      supportMemories,
      growthMemories,
      standupCommands: memoriesData.standupCommands,
      wrapUpInputs
    });
    
    // Crear el comando
    const command = CommandFactory.createCommand({
      task: 'daily standup executive summary',
      userId: agent.userId,
      agentId: agent.agentId,
      site_id: site_id,
      description: 'Consolidate all daily standup analyses into executive summary and actionable recommendations',
      modelType: 'openai',
      modelId: 'gpt-5-mini',
      targets: [
        {
          subject: "Plain text key task or focus for the day (no markdown or special characters)",
          message: "Most important, news, leads, opportunities, warning, tasks or focus for the day (no markdown or special characters) keep it short and concise",
          health: {
            status: "GREEN|YELLOW|RED",
            reason: "Short plain text reason (no emojis, no markdown)",
            priorities: ["Short plain text priority items under 140 chars each"]
          }
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
    
    // Esperar a que el comando se complete (hasta ~190s)
    const { command: executedCommand, completed } = await waitForCommandCompletion(
      commandService,
      internalCommandId,
      190,
      1000
    );
    
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
    
    // Extraer resultados simplificados: subject, message, health
    let summary = "Executive summary completed";
    let subject = "";
    let message = "";
    let health: { status: 'GREEN' | 'YELLOW' | 'RED'; reason: string; priorities: string[] } | null = null;
    
    if (executedCommand.results && Array.isArray(executedCommand.results)) {
      const analysisResults = executedCommand.results.find((r: any) => 
        r.subject || r.message || r.health || r.content || r.summary
      );
      
      if (analysisResults) {
        if (analysisResults.content) {
          summary = analysisResults.content;
        } else if (analysisResults.summary) {
          summary = analysisResults.summary;
        }
        
        // Campos directos esperados
        if (analysisResults.subject) {
          subject = analysisResults.subject;
        }
        if (analysisResults.message) {
          message = analysisResults.message;
        }
        if (analysisResults.health && typeof analysisResults.health === 'object') {
          const h = analysisResults.health as any;
          if (typeof h.status === 'string') {
            const up = h.status.toUpperCase();
            if (up === 'GREEN' || up === 'YELLOW' || up === 'RED') {
              health = {
                status: up,
                reason: typeof h.reason === 'string' ? h.reason : '',
                priorities: Array.isArray(h.priorities) ? h.priorities.map((p: any) => String(p)) : []
              };
            }
          }
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
    
    // Fallbacks: si no hay message/health en resultados, intentar parsear del resumen en texto plano
    if (!message && typeof summary === 'string') {
      message = summary;
    }
    if (!health && typeof message === 'string' && message.trim().length > 0) {
      const lines = message.split('\n').map(l => l.trim()).filter(Boolean);
      const statusLine = lines.find(l => /^Status:\s*(GREEN|YELLOW|RED)/i.test(l));
      if (statusLine) {
        const match = statusLine.match(/^Status:\s*(GREEN|YELLOW|RED)\s*-\s*(.*)$/i);
        const status = match ? match[1].toUpperCase() : 'YELLOW';
        const reason = match ? match[2].trim() : '';
        const priorities = lines
          .filter(l => l.startsWith('- '))
          .map(l => l.substring(2).trim())
          .filter(l => l.length > 0);
        if (status === 'GREEN' || status === 'YELLOW' || status === 'RED') {
          health = { status: status as 'GREEN' | 'YELLOW' | 'RED', reason, priorities };
        }
      }
    }
    
    // Build optional systemAnalysis for daily standup notification compatibility
    let systemAnalysis: any = undefined;
    if (health) {
      const assessmentLines = [
        `Status: ${health.status} - ${health.reason}`,
        ...health.priorities.map(p => `- ${p}`)
      ];
      systemAnalysis = {
        success: true,
        command_id: executedCommand.id,
        strategic_analysis: {
          business_assessment: assessmentLines.join('\n')
        },
        analysis_type: 'executive_wrapup'
      };
    }

    return NextResponse.json(
      {
        success: true,
        data: {
          subject,
          message,
          health,
          ...(systemAnalysis ? { systemAnalysis } : {}),
          ...(leadsAndMessagesSummary ? { leads_and_messages_summary: leadsAndMessagesSummary } : {})
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