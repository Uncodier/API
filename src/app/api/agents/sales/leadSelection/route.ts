import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';
import { 
  getLeadInfo, 
  getLeadTasks,
  getLeadConversations,
  getPreviousInteractions 
} from '@/lib/helpers/lead-context-helper';

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Función para obtener leads convertidos por segmento con attribution
async function getConvertedLeadsBySegment(siteId: string, limit: number = 5): Promise<Record<string, any[]>> {
  try {
    console.log(`📈 Obteniendo leads convertidos por segmento para sitio: ${siteId}`);
    
    const { data: convertedLeads, error } = await supabaseAdmin
      .from('leads')
      .select(`
        *,
        segments!inner(id, name, description),
        sales!left(*)
      `)
      .eq('site_id', siteId)
      .eq('status', 'converted')
      .not('segment_id', 'is', null)
      .not('attribution', 'is', null)
      .order('created_at', { ascending: false });
    
    if (error) {
      console.error('Error al obtener leads convertidos:', error);
      return {};
    }
    
    if (!convertedLeads || convertedLeads.length === 0) {
      console.log('⚠️ No se encontraron leads convertidos');
      return {};
    }
    
    // Agrupar por segmento y limitar por segmento
    const leadsBySegment: Record<string, any[]> = {};
    
    for (const lead of convertedLeads) {
      const segmentId = lead.segment_id;
      const segmentName = (lead.segments as any)?.[0]?.name || 'Unknown Segment';
      
      if (!leadsBySegment[segmentName]) {
        leadsBySegment[segmentName] = [];
      }
      
      if (leadsBySegment[segmentName].length < limit) {
        leadsBySegment[segmentName].push({
          ...lead,
          segment_name: segmentName
        });
      }
    }
    
    console.log(`✅ Encontrados leads convertidos en ${Object.keys(leadsBySegment).length} segmentos`);
    return leadsBySegment;
    
  } catch (error) {
    console.error('Error al obtener leads convertidos por segmento:', error);
    return {};
  }
}

// Función para obtener leads perdidos por segmento con attribution
async function getLostLeadsBySegment(siteId: string, limit: number = 5): Promise<Record<string, any[]>> {
  try {
    console.log(`📉 Obteniendo leads perdidos por segmento para sitio: ${siteId}`);
    
    const { data: lostLeads, error } = await supabaseAdmin
      .from('leads')
      .select(`
        *,
        segments!inner(id, name, description)
      `)
      .eq('site_id', siteId)
      .eq('status', 'lost')
      .not('segment_id', 'is', null)
      .not('attribution', 'is', null)
      .order('created_at', { ascending: false });
    
    if (error) {
      console.error('Error al obtener leads perdidos:', error);
      return {};
    }
    
    if (!lostLeads || lostLeads.length === 0) {
      console.log('⚠️ No se encontraron leads perdidos');
      return {};
    }
    
    // Agrupar por segmento y limitar por segmento
    const leadsBySegment: Record<string, any[]> = {};
    
    for (const lead of lostLeads) {
      const segmentId = lead.segment_id;
      const segmentName = (lead.segments as any)?.[0]?.name || 'Unknown Segment';
      
      if (!leadsBySegment[segmentName]) {
        leadsBySegment[segmentName] = [];
      }
      
      if (leadsBySegment[segmentName].length < limit) {
        leadsBySegment[segmentName].push({
          ...lead,
          segment_name: segmentName
        });
      }
    }
    
    console.log(`✅ Encontrados leads perdidos en ${Object.keys(leadsBySegment).length} segmentos`);
    return leadsBySegment;
    
  } catch (error) {
    console.error('Error al obtener leads perdidos por segmento:', error);
    return {};
  }
}

// Función para obtener team members con más atribuciones por segmento
async function getTeamMemberAttributionsBySegment(siteId: string): Promise<Record<string, any>> {
  try {
    console.log(`📊 Calculando atribuciones de team members por segmento para sitio: ${siteId}`);
    
    // Buscar leads convertidos agrupados por segmento y assignee_id
    const { data: convertedLeads, error } = await supabaseAdmin
      .from('leads')
      .select(`
        segment_id, 
        assignee_id, 
        attribution,
        segments!inner(id, name, description),
        sales!left(amount)
      `)
      .eq('site_id', siteId)
      .eq('status', 'converted')
      .not('assignee_id', 'is', null)
      .not('segment_id', 'is', null);
    
    if (error) {
      console.error('Error al obtener leads convertidos:', error);
      return {};
    }
    
    if (!convertedLeads || convertedLeads.length === 0) {
      console.log('⚠️ No se encontraron leads convertidos para calcular atribuciones');
      return {};
    }
    
    // Agrupar conversiones por segmento y assignee_id
    const segmentAttributions: Record<string, Record<string, any>> = {};
    
    for (const lead of convertedLeads) {
      const segmentName = (lead.segments as any)?.[0]?.name || 'Unknown Segment';
      const assigneeId = lead.assignee_id;
      
      if (!segmentAttributions[segmentName]) {
        segmentAttributions[segmentName] = {};
      }
      
      if (!segmentAttributions[segmentName][assigneeId]) {
        segmentAttributions[segmentName][assigneeId] = {
          assignee_id: assigneeId,
          conversions: 0,
          total_sales: 0,
          attribution_data: []
        };
      }
      
      segmentAttributions[segmentName][assigneeId].conversions += 1;
      
      // Sumar ventas si existen
      if (lead.sales && Array.isArray(lead.sales) && lead.sales.length > 0) {
        const totalSalesAmount = lead.sales.reduce((sum: number, sale: any) => sum + (sale.amount || 0), 0);
        segmentAttributions[segmentName][assigneeId].total_sales += totalSalesAmount;
      }
      
      // Almacenar datos de atribución
      if (lead.attribution) {
        segmentAttributions[segmentName][assigneeId].attribution_data.push(lead.attribution);
      }
    }
    
    // Encontrar el team member con más atribuciones para cada segmento
    const bestAssigneeBySegment: Record<string, any> = {};
    
    for (const [segmentName, assignees] of Object.entries(segmentAttributions)) {
      let bestAssignee = null;
      let maxScore = 0;
      
      for (const assigneeData of Object.values(assignees)) {
        // Calcular score basado en conversiones y ventas
        const score = (assigneeData as any).conversions * 10 + ((assigneeData as any).total_sales / 1000);
        if (score > maxScore) {
          maxScore = score;
          bestAssignee = assigneeData;
        }
      }
      
      if (bestAssignee) {
        bestAssigneeBySegment[segmentName] = {
          ...bestAssignee,
          score: maxScore
        };
      }
    }
    
    // Obtener información adicional de los team members
    for (const [segmentName, assigneeData] of Object.entries(bestAssigneeBySegment)) {
      try {
        const { data: userData, error: userError } = await supabaseAdmin.auth.admin.getUserById(assigneeData.assignee_id);
        if (!userError && userData.user) {
          assigneeData.name = userData.user.user_metadata?.name || userData.user.user_metadata?.full_name || userData.user.email;
          assigneeData.email = userData.user.email;
        }
      } catch (userError) {
        console.warn(`Error obteniendo info del usuario ${assigneeData.assignee_id}:`, userError);
      }
    }
    
    console.log(`✅ Calculadas atribuciones para ${Object.keys(bestAssigneeBySegment).length} segmentos`);
    return bestAssigneeBySegment;
    
  } catch (error) {
    console.error('Error al obtener atribuciones de team members por segmento:', error);
    return {};
  }
}

// Inicializar el agente y obtener el servicio de comandos
const processorInitializer = ProcessorInitializer.getInstance();
processorInitializer.initialize();
const commandService = processorInitializer.getCommandService();

// Función para obtener el UUID de la base de datos para un comando
async function getCommandDbUuid(internalId: string): Promise<string | null> {
  try {
    const command = await commandService.getCommandById(internalId);
    
    if (command && command.metadata && command.metadata.dbUuid) {
      if (isValidUUID(command.metadata.dbUuid)) {
        console.log(`🔑 UUID encontrado en metadata: ${command.metadata.dbUuid}`);
        return command.metadata.dbUuid;
      }
    }
    
    return null;
  } catch (error) {
    console.error('Error al obtener UUID de base de datos:', error);
    return null;
  }
}

// Función para encontrar un agente activo por role
async function findActiveAgentByRole(siteId: string, role: string): Promise<{agentId: string, userId: string} | null> {
  try {
    if (!siteId || !isValidUUID(siteId)) {
      console.error(`❌ Invalid site_id for agent search: ${siteId}`);
      return null;
    }
    
    console.log(`🔍 Buscando agente activo con role "${role}" para el sitio: ${siteId}`);
    
    const { data, error } = await supabaseAdmin
      .from('agents')
      .select('id, user_id')
      .eq('site_id', siteId)
      .eq('role', role)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1);
    
    if (error) {
      console.error(`Error al buscar agente con role "${role}":`, error);
      return null;
    }
    
    if (!data || data.length === 0) {
      console.log(`⚠️ No active agent found with role "${role}" for site: ${siteId}`);
      return null;
    }
    
    console.log(`✅ Agente con role "${role}" encontrado: ${data[0].id} (user_id: ${data[0].user_id})`);
    return {
      agentId: data[0].id,
      userId: data[0].user_id
    };
  } catch (error) {
    console.error(`Error al buscar agente con role "${role}":`, error);
    return null;
  }
}

// Función para encontrar un agente de ventas activo
async function findActiveSalesAgent(siteId: string): Promise<{agentId: string, userId: string} | null> {
  return await findActiveAgentByRole(siteId, 'Sales/CRM Specialist');
}

// Función para obtener canales configurados del sitio
async function getSiteChannelsConfiguration(siteId: string): Promise<{
  hasChannels: boolean,
  configuredChannels: string[],
  channelsDetails: Record<string, any>,
  warning?: string
}> {
  try {
    console.log(`📡 Obteniendo configuración de canales para sitio: ${siteId}`);
    
    const { data, error } = await supabaseAdmin
      .from('settings')
      .select('channels')
      .eq('site_id', siteId)
      .single();
    
    if (error || !data?.channels) {
      const warning = `⚠️ Site ${siteId} has NO channels configured in settings. Lead contact recommendations will be limited.`;
      console.warn(warning);
      
      return {
        hasChannels: false,
        configuredChannels: [],
        channelsDetails: {},
        warning: 'No channels configured - lead contact options will be limited'
      };
    }
    
    const channels = data.channels;
    const configuredChannels: string[] = [];
    const channelsDetails: Record<string, any> = {};
    
    // Verificar cada tipo de canal disponible
    if (channels.email && (channels.email.email || channels.email.aliases)) {
      configuredChannels.push('email');
      channelsDetails.email = {
        type: 'email',
        email: channels.email.email || null,
        aliases: channels.email.aliases || [],
        description: 'Email marketing and outreach'
      };
    }
    
    if (channels.whatsapp && channels.whatsapp.phone_number) {
      configuredChannels.push('whatsapp');
      channelsDetails.whatsapp = {
        type: 'whatsapp',
        phone_number: channels.whatsapp.phone_number,
        description: 'WhatsApp Business messaging'
      };
    }
    
    if (channels.phone && channels.phone.number) {
      configuredChannels.push('phone');
      channelsDetails.phone = {
        type: 'phone',
        number: channels.phone.number,
        description: 'Direct phone calls'
      };
    }
    
    if (channels.sms && channels.sms.phone_number) {
      configuredChannels.push('sms');
      channelsDetails.sms = {
        type: 'sms',
        phone_number: channels.sms.phone_number,
        description: 'SMS text messaging'
      };
    }
    
    if (channels.chat && channels.chat.enabled) {
      configuredChannels.push('chat');
      channelsDetails.chat = {
        type: 'chat',
        enabled: channels.chat.enabled,
        description: 'Live chat on website'
      };
    }
    
    if (channels.social && (channels.social.facebook || channels.social.twitter || channels.social.linkedin)) {
      configuredChannels.push('social');
      channelsDetails.social = {
        type: 'social',
        platforms: {
          facebook: channels.social.facebook || null,
          twitter: channels.social.twitter || null,
          linkedin: channels.social.linkedin || null
        },
        description: 'Social media outreach'
      };
    }
    
    if (configuredChannels.length === 0) {
      const warning = `⚠️ Site ${siteId} has channels object but NO FUNCTIONAL channels configured. Available channels: ${Object.keys(channels).join(', ')}. Lead contact recommendations will be limited.`;
      console.warn(warning);
      
      return {
        hasChannels: false,
        configuredChannels: [],
        channelsDetails: {},
        warning: 'Channels object exists but no functional channels configured - lead contact options will be limited'
      };
    }
    
    console.log(`✅ Site ${siteId} has ${configuredChannels.length} channels configured: ${configuredChannels.join(', ')}`);
    
    return {
      hasChannels: true,
      configuredChannels,
      channelsDetails,
      warning: undefined
    };
    
  } catch (error) {
    console.error('Error al verificar configuración de canales del sitio:', error);
    const warning = `⚠️ ERROR: Could not verify channels configuration for site ${siteId}. Lead contact recommendations may be affected.`;
    console.warn(warning);
    
    return {
      hasChannels: false,
      configuredChannels: [],
      channelsDetails: {},
      warning: 'Could not verify channels configuration - lead contact recommendations may be affected'
    };
  }
}

// Función para obtener team members disponibles para asignación
async function getAvailableTeamMembers(siteId: string): Promise<any[]> {
  try {
    console.log(`👥 Buscando team members disponibles para sitio: ${siteId}`);
    
    // Buscar usuarios que tengan acceso al sitio
    const { data: siteMembers, error } = await supabaseAdmin
      .from('site_members')
      .select('user_id, role')
      .eq('site_id', siteId)
      .eq('status', 'active')
      .in('role', ['admin', 'member', 'sales_agent']); // Roles que pueden ser asignados a leads
    
    if (error) {
      console.error('Error al obtener team members:', error);
      return [];
    }
    
    if (!siteMembers || siteMembers.length === 0) {
      console.log('⚠️ No se encontraron team members disponibles');
      return [];
    }
    
    // Obtener información adicional de los team members
    const teamMembersInfo = [];
    for (const member of siteMembers) {
      try {
        const { data: userData, error: userError } = await supabaseAdmin.auth.admin.getUserById(member.user_id);
        if (!userError && userData.user) {
          teamMembersInfo.push({
            id: member.user_id,
            email: userData.user.email,
            name: userData.user.user_metadata?.name || userData.user.user_metadata?.full_name || userData.user.email,
            role: member.role
          });
        }
      } catch (userError) {
        console.warn(`Error obteniendo info del usuario ${member.user_id}:`, userError);
      }
    }
    
    console.log(`✅ Encontrados ${teamMembersInfo.length} team members disponibles`);
    return teamMembersInfo;
    
  } catch (error) {
    console.error('Error al obtener team members disponibles:', error);
    return [];
  }
}

// Función para esperar a que un comando se complete
async function waitForCommandCompletion(commandId: string, maxAttempts = 100, delayMs = 1000) {
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
        
        if (executedCommand.metadata && executedCommand.metadata.dbUuid) {
          dbUuid = executedCommand.metadata.dbUuid as string;
          console.log(`🔑 UUID de base de datos encontrado en metadata: ${dbUuid}`);
        }
        
        if (executedCommand.status === 'completed' || executedCommand.status === 'failed') {
          console.log(`✅ Comando ${commandId} completado con estado: ${executedCommand.status}`);
          
          if (!dbUuid || !isValidUUID(dbUuid)) {
            dbUuid = await getCommandDbUuid(commandId);
            console.log(`🔍 UUID obtenido después de completar: ${dbUuid || 'No encontrado'}`);
          }
          
          clearInterval(checkInterval);
          resolve({command: executedCommand, dbUuid, completed: executedCommand.status === 'completed'});
          return;
        }
        
        console.log(`⏳ Comando ${commandId} aún en ejecución (estado: ${executedCommand.status}), intento ${attempts}/${maxAttempts}`);
        
        if (attempts >= maxAttempts) {
          console.log(`⏰ Tiempo de espera agotado para el comando ${commandId}`);
          
          if (!dbUuid || !isValidUUID(dbUuid)) {
            dbUuid = await getCommandDbUuid(commandId);
            console.log(`🔍 UUID obtenido antes de timeout: ${dbUuid || 'No encontrado'}`);
          }
          
          clearInterval(checkInterval);
          resolve({command: executedCommand, dbUuid, completed: false});
        }
      } catch (error) {
        console.error(`Error al verificar estado del comando ${commandId}:`, error);
        clearInterval(checkInterval);
        resolve({command: null, dbUuid: null, completed: false});
      }
    }, delayMs);
  });
}

// Función para procesar y enriquecer la información de un lead
async function processLeadData(leadId: string): Promise<any> {
  try {
    console.log(`🔍 Procesando datos del lead: ${leadId}`);
    
    // Obtener información básica del lead
    const leadInfo = await getLeadInfo(leadId);
    if (!leadInfo) {
      console.error(`❌ No se pudo obtener información del lead: ${leadId}`);
      return null;
    }
    
    // Obtener tareas del lead
    const leadTasks = await getLeadTasks(leadId);
    
    // Obtener conversaciones del lead
    const leadConversations = await getLeadConversations(leadId);
    
    // Obtener interacciones previas
    const previousInteractions = await getPreviousInteractions(leadId, 10);
    
    console.log(`📊 Lead ${leadId}: ${leadTasks.length} tareas, ${leadConversations.length} conversaciones, ${previousInteractions.length} interacciones`);
    
    return {
      lead: leadInfo,
      tasks: leadTasks,
      conversations: leadConversations,
      interactions: previousInteractions
    };
  } catch (error) {
    console.error(`Error procesando datos del lead ${leadId}:`, error);
    return null;
  }
}

// Función para agrupar leads por compañía
function groupLeadsByCompany(leadsData: any[]): Map<string, any[]> {
  const companiesMap = new Map<string, any[]>();
  
  for (const leadData of leadsData) {
    if (!leadData || !leadData.lead) continue;
    
    const company = String(leadData.lead.company || 'Unknown Company');
    const companyKey = company.toLowerCase().trim();
    
    if (!companiesMap.has(companyKey)) {
      companiesMap.set(companyKey, []);
    }
    
    companiesMap.get(companyKey)!.push(leadData);
  }
  
  return companiesMap;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    
    // Extraer parámetros de la solicitud
    const { 
      siteId, 
      leads, // Array de lead IDs o objetos con lead info
      userId, 
      agent_id,
      includeTeamMembers = true,
      priorityFactors = {
        recentActivity: 0.3,
        companySize: 0.2,
        engagement: 0.3,
        leadScore: 0.2
      }
    } = body;
    
    // Validar parámetros requeridos
    if (!siteId) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'siteId is required' } },
        { status: 400 }
      );
    }
    
    if (!leads || !Array.isArray(leads) || leads.length === 0) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'leads array is required and must not be empty' } },
        { status: 400 }
      );
    }
    
    console.log(`🎯 Iniciando selección de leads para ${leads.length} leads en sitio: ${siteId}`);
    
    // Buscar agente de ventas activo si no se proporciona un agent_id
    let effectiveAgentId = agent_id;
    let agentInfo: any = null;
    let effectiveUserId = userId;
    
    if (!effectiveAgentId) {
      const foundAgent = await findActiveSalesAgent(siteId);
      if (foundAgent) {
        effectiveAgentId = foundAgent.agentId;
        effectiveUserId = foundAgent.userId;
        console.log(`🤖 Usando agente de ventas encontrado: ${effectiveAgentId} (user_id: ${effectiveUserId})`);
      } else {
        console.log(`⚠️ No se encontró un agente activo para el sitio: ${siteId}`);
      }
    }
    
    if (!effectiveUserId) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'userId is required and no active agent found for the site' } },
        { status: 400 }
      );
    }
    
    // Procesar cada lead para obtener su información completa
    console.log(`📋 Procesando información de ${leads.length} leads...`);
    const leadsData = [];
    
    for (const leadInput of leads) {
      let leadId: string;
      
      // El input puede ser un string (lead ID) o un objeto con información del lead
      if (typeof leadInput === 'string') {
        leadId = leadInput;
      } else if (leadInput && leadInput.id) {
        leadId = leadInput.id;
      } else {
        console.warn(`⚠️ Lead input inválido:`, leadInput);
        continue;
      }
      
      if (!isValidUUID(leadId)) {
        console.warn(`⚠️ Lead ID inválido: ${leadId}`);
        continue;
      }
      
      const leadData = await processLeadData(leadId);
      if (leadData) {
        leadsData.push(leadData);
      }
    }
    
    console.log(`✅ Procesados exitosamente ${leadsData.length} de ${leads.length} leads`);
    
    if (leadsData.length === 0) {
      return NextResponse.json(
        { success: false, error: { code: 'NO_VALID_LEADS', message: 'No valid leads found to process' } },
        { status: 400 }
      );
    }
    
    // Agrupar leads por compañía
    const companiesMap = groupLeadsByCompany(leadsData);
    console.log(`🏢 Leads agrupados en ${companiesMap.size} compañías`);
    
    // Obtener team members disponibles si se solicita
    let teamMembers: any[] = [];
    if (includeTeamMembers) {
      teamMembers = await getAvailableTeamMembers(siteId);
    }

    // Obtener configuración de canales del sitio
    const siteChannelsConfig = await getSiteChannelsConfiguration(siteId);

    // Obtener leads convertidos y perdidos por segmento
    const convertedLeadsBySegment = await getConvertedLeadsBySegment(siteId);
    const lostLeadsBySegment = await getLostLeadsBySegment(siteId);

    // Obtener atribuciones de team members por segmento
    const teamMemberAttributionsBySegment = await getTeamMemberAttributionsBySegment(siteId);
    
    // Preparar el contexto para el comando
    let contextMessage = `Lead Selection Analysis for Site: ${siteId}\n\n`;
    contextMessage += `Total Leads to Analyze: ${leadsData.length}\n`;
    contextMessage += `Companies Represented: ${companiesMap.size}\n\n`;
    
    // Añadir información detallada por compañía
    contextMessage += `=== DETAILED COMPANY ANALYSIS ===\n\n`;
    
         let companyIndex = 1;
     for (const [companyName, companyLeads] of Array.from(companiesMap.entries())) {
       contextMessage += `COMPANY ${companyIndex}: ${String(companyName).toUpperCase()}\n`;
       contextMessage += `├─ Total Leads: ${companyLeads.length}\n\n`;
       
       companyLeads.forEach((leadData: any, index: number) => {
         const lead = leadData.lead;
         const tasks = leadData.tasks;
         const conversations = leadData.conversations;
         const interactions = leadData.interactions;
         
         contextMessage += `   LEAD ${index + 1} - ${lead.name || 'Unknown'}\n`;
         contextMessage += `   ├─ ID: ${lead.id}\n`;
         contextMessage += `   ├─ Email: ${lead.email || 'N/A'}\n`;
         contextMessage += `   ├─ Phone: ${lead.phone || 'N/A'}\n`;
         contextMessage += `   ├─ Position: ${lead.position || 'N/A'}\n`;
         contextMessage += `   ├─ Status: ${lead.status || 'N/A'}\n`;
         contextMessage += `   ├─ Created: ${lead.created_at}\n`;
         contextMessage += `   ├─ Assignee: ${lead.assignee_id ? lead.assignee_id : 'Unassigned'}\n`;
         
         if (lead.lead_score) {
           contextMessage += `   ├─ Lead Score: ${lead.lead_score}\n`;
         }
         
         if (lead.pain_points && Array.isArray(lead.pain_points)) {
           contextMessage += `   ├─ Pain Points: ${lead.pain_points.join(', ')}\n`;
         }
         
         if (lead.budget_range) {
           contextMessage += `   ├─ Budget Range: ${lead.budget_range}\n`;
         }
         
         contextMessage += `   ├─ Tasks: ${tasks.length} total\n`;
         if (tasks.length > 0) {
           tasks.slice(0, 3).forEach((task: any, taskIndex: number) => {
             contextMessage += `   │   ${taskIndex + 1}. ${task.title} (${task.status})\n`;
           });
           if (tasks.length > 3) {
             contextMessage += `   │   ... and ${tasks.length - 3} more tasks\n`;
           }
         }
         
         contextMessage += `   ├─ Conversations: ${conversations.length} total\n`;
         if (conversations.length > 0) {
           conversations.slice(0, 2).forEach((conv: any, convIndex: number) => {
             contextMessage += `   │   ${convIndex + 1}. ${conv.title || 'Untitled'} (${conv.status}) - ${conv.created_at}\n`;
           });
           if (conversations.length > 2) {
             contextMessage += `   │   ... and ${conversations.length - 2} more conversations\n`;
           }
         }
         
         contextMessage += `   └─ Recent Interactions: ${interactions.length} total\n`;
         if (interactions.length > 0) {
           interactions.slice(0, 2).forEach((interaction: any, intIndex: number) => {
             contextMessage += `       ${intIndex + 1}. ${interaction.type}: ${interaction.title || 'N/A'} - ${interaction.created_at}\n`;
           });
           if (interactions.length > 2) {
             contextMessage += `       ... and ${interactions.length - 2} more interactions\n`;
           }
         }
         
         contextMessage += `\n`;
       });
       
       companyIndex++;
       contextMessage += `\n`;
     }

    // Añadir información de leads convertidos y perdidos por segmento
    contextMessage += `=== CONVERTED LEADS BY SEGMENT ===\n\n`;
    for (const [segmentName, leads] of Object.entries(convertedLeadsBySegment)) {
      contextMessage += `Segment: ${String(segmentName).toUpperCase()}\n`;
      contextMessage += `├─ Total Converted: ${leads.length}\n`;
      if (leads.length > 0) {
        leads.slice(0, 3).forEach((lead: any, index: number) => {
          contextMessage += `   ${index + 1}. ${lead.name || 'Unknown'} (ID: ${lead.id}, Sales: ${lead.sales?.length || 0})\n`;
        });
        if (leads.length > 3) {
          contextMessage += `   ... and ${leads.length - 3} more converted leads\n`;
        }
      }
      contextMessage += `\n`;
    }

    contextMessage += `=== LOST LEADS BY SEGMENT ===\n\n`;
    for (const [segmentName, leads] of Object.entries(lostLeadsBySegment)) {
      contextMessage += `Segment: ${String(segmentName).toUpperCase()}\n`;
      contextMessage += `├─ Total Lost: ${leads.length}\n`;
      if (leads.length > 0) {
        leads.slice(0, 3).forEach((lead: any, index: number) => {
          contextMessage += `   ${index + 1}. ${lead.name || 'Unknown'} (ID: ${lead.id}, Attribution: ${lead.attribution?.name || 'N/A'})\n`;
        });
        if (leads.length > 3) {
          contextMessage += `   ... and ${leads.length - 3} more lost leads\n`;
        }
      }
      contextMessage += `\n`;
    }

    // Añadir información de atribuciones de team members por segmento
    contextMessage += `=== TEAM MEMBER ATTRIBUTIONS BY SEGMENT ===\n\n`;
    for (const [segmentName, assigneeData] of Object.entries(teamMemberAttributionsBySegment)) {
      contextMessage += `Segment: ${String(segmentName).toUpperCase()}\n`;
      contextMessage += `├─ Best Assignee: ${assigneeData.name || 'N/A'} (ID: ${assigneeData.assignee_id}, Score: ${assigneeData.score})\n`;
      contextMessage += `│  ├─ Conversions: ${assigneeData.conversions}\n`;
      contextMessage += `│  └─ Total Sales: ${assigneeData.total_sales.toLocaleString()}\n`;
      if (assigneeData.attribution_data && assigneeData.attribution_data.length > 0) {
        contextMessage += `│  └─ Attribution Data: ${assigneeData.attribution_data.length} records\n`;
      }
      contextMessage += `\n`;
    }
    
    // Añadir información de team members si está disponible
    if (teamMembers.length > 0) {
      contextMessage += `=== AVAILABLE TEAM MEMBERS ===\n\n`;
      teamMembers.forEach((member, index) => {
        contextMessage += `${index + 1}. ${member.name} (${member.role})\n`;
        contextMessage += `   ├─ ID: ${member.id}\n`;
        contextMessage += `   └─ Email: ${member.email}\n\n`;
      });
    }

    // Añadir información de canales configurados del sitio
    contextMessage += `=== SITE CHANNELS CONFIGURATION ===\n\n`;
    if (siteChannelsConfig.hasChannels) {
      contextMessage += `Site has ${siteChannelsConfig.configuredChannels.length} channels configured:\n\n`;
      siteChannelsConfig.configuredChannels.forEach((channelType, index) => {
        const channelDetails = siteChannelsConfig.channelsDetails[channelType];
        contextMessage += `${index + 1}. ${channelType.toUpperCase()}\n`;
        contextMessage += `   ├─ Type: ${channelDetails.type}\n`;
        contextMessage += `   ├─ Description: ${channelDetails.description}\n`;
        
        if (channelDetails.email) {
          contextMessage += `   ├─ Email: ${channelDetails.email}\n`;
        }
        if (channelDetails.aliases && channelDetails.aliases.length > 0) {
          contextMessage += `   ├─ Aliases: ${channelDetails.aliases.join(', ')}\n`;
        }
        if (channelDetails.phone_number) {
          contextMessage += `   ├─ Phone: ${channelDetails.phone_number}\n`;
        }
        if (channelDetails.number) {
          contextMessage += `   ├─ Number: ${channelDetails.number}\n`;
        }
        if (channelDetails.enabled !== undefined) {
          contextMessage += `   ├─ Enabled: ${channelDetails.enabled}\n`;
        }
        if (channelDetails.platforms) {
          const platforms = Object.entries(channelDetails.platforms)
            .filter(([_, url]) => url)
            .map(([platform, url]) => `${platform}: ${url}`)
            .join(', ');
          if (platforms) {
            contextMessage += `   ├─ Platforms: ${platforms}\n`;
          }
        }
        contextMessage += `   └─ Available for lead contact\n\n`;
      });
    } else {
      contextMessage += `⚠️ WARNING: Site has NO channels configured!\n`;
      contextMessage += `   This will severely limit contact recommendations.\n`;
      if (siteChannelsConfig.warning) {
        contextMessage += `   Details: ${siteChannelsConfig.warning}\n`;
      }
      contextMessage += `\n`;
    }
    
    // Añadir instrucciones para el agente
    contextMessage += `=== ANALYSIS INSTRUCTIONS ===\n\n`;
    contextMessage += `As a Sales/CRM Specialist, analyze the provided leads and provide strategic recommendations for:\n\n`;
    contextMessage += `1. CONTACT PRIORITY: For each company with multiple leads, determine which lead should be contacted FIRST and why\n`;
    contextMessage += `2. STRATEGIC ACCOUNT ASSIGNMENTS: Identify ONLY the most high-value companies that truly require dedicated team member assignment\n`;
    contextMessage += `3. CONTACT STRATEGY: Recommend the best approach for each priority lead\n\n`;
    contextMessage += `CRITICAL CHANNEL RESTRICTIONS:\n`;
    if (siteChannelsConfig.hasChannels) {
      contextMessage += `- ONLY use channels that are configured for this site: ${siteChannelsConfig.configuredChannels.join(', ')}\n`;
      contextMessage += `- DO NOT recommend channels that are not configured for this site\n`;
      contextMessage += `- When a lead has multiple contact methods (email, phone, etc.), prioritize channels that the site has configured\n`;
      contextMessage += `- If a lead's preferred channel is not configured, suggest the best alternative from available channels\n`;
    } else {
      contextMessage += `- ⚠️ CRITICAL: Site has NO channels configured! Contact recommendations will be severely limited\n`;
      contextMessage += `- Recommend that the site configure at least one communication channel before implementing contact strategies\n`;
      contextMessage += `- Focus on lead prioritization and preparation rather than specific contact methods\n`;
    }
    contextMessage += `\n`;
    contextMessage += `CRITICAL ASSIGNMENT GUIDELINES:\n`;
    contextMessage += `- DO NOT assign ALL leads to team members\n`;
    contextMessage += `- ONLY assign leads from companies that represent significant strategic value (top 20-30% of accounts)\n`;
    contextMessage += `- Prioritize assigning team members who have proven success in specific segments based on attribution data\n`;
    contextMessage += `- Consider the team member's track record with similar companies/segments when making assignments\n`;
    contextMessage += `- Leave lower-value or routine leads unassigned for general team handling\n\n`;
    contextMessage += `STRICT ROLE RESTRICTIONS (Multilingual):\n`;
    contextMessage += `- EN: Do NOT assign leads to external consultants, contractors, freelancers, vendors, or external collaborators unless their role is Sales, SDR, or BDR.\n`;
    contextMessage += `- ES: NO asignes leads a consultores externos, contratistas, freelancers, proveedores o colaboradores externos salvo que su rol sea Vendedor, SDR o BDR.\n`;
    contextMessage += `- PT: NÃO atribua leads a consultores externos, contratados, freelancers, fornecedores ou colaboradores externos, a menos que o cargo seja Vendas, SDR ou BDR.\n`;
    contextMessage += `- FR: N'ASSIGNEZ PAS de leads à des consultants externes, sous-traitants, freelances, fournisseurs ou collaborateurs externes sauf si leur rôle est Ventes, SDR ou BDR.\n`;
    contextMessage += `- IT: NON assegnare lead a consulenti esterni, contractor, freelancer, fornitori o collaboratori esterni, salvo che il ruolo sia Vendite, SDR o BDR.\n`;
    contextMessage += `- DE: Weisen Sie KEINE Leads an externe Berater, Auftragnehmer, Freelancer, Anbieter oder externe Mitarbeiter zu, außer ihre Rolle ist Vertrieb, SDR oder BDR.\n`;
    contextMessage += `- Synonyms: external consultant, contractor, freelancer, vendor, collaborator, outsource, third-party.\n`;
    contextMessage += `- Allowed roles: sales_agent, seller, SDR, BDR only.\n\n`;
    contextMessage += `Consider these factors in your analysis:\n`;
    contextMessage += `- Historical conversion patterns from segment data provided\n`;
    contextMessage += `- Team member attribution success rates by segment\n`;
    contextMessage += `- Recent activity and engagement level\n`;
    contextMessage += `- Lead scores and qualification status\n`;
    contextMessage += `- Company size and potential value\n`;
    contextMessage += `- Existing relationships and conversation history\n`;
    contextMessage += `- Task completion status and follow-up needs\n`;
    contextMessage += `- Patterns from converted vs lost leads in same segments\n`;
    contextMessage += `- Available site communication channels and their capabilities\n`;
    contextMessage += `- Lead contact preferences vs site channel availability\n\n`;
    contextMessage += `Priority Factors Configuration:\n`;
    contextMessage += `- Recent Activity Weight: ${priorityFactors.recentActivity}\n`;
    contextMessage += `- Company Size Weight: ${priorityFactors.companySize}\n`;
    contextMessage += `- Engagement Weight: ${priorityFactors.engagement}\n`;
    contextMessage += `- Lead Score Weight: ${priorityFactors.leadScore}\n\n`;
    contextMessage += `SEGMENT PERFORMANCE INSIGHTS:\n`;
    contextMessage += `Use the provided converted and lost leads data to understand:\n`;
    contextMessage += `- Which segments have higher conversion rates\n`;
    contextMessage += `- What attribution factors led to successful conversions\n`;
    contextMessage += `- Common patterns in lost leads to avoid\n`;
    contextMessage += `- Which team members excel in specific segments\n\n`;
    
    // Crear el comando para análisis de selección de leads
    console.log(`🚀 Creando comando de selección de leads`);
    const leadSelectionCommand = CommandFactory.createCommand({
      task: 'lead selection analysis',
      userId: effectiveUserId,
      agentId: effectiveAgentId,
      agentRole: 'Sales/CRM Specialist',
      site_id: siteId,
      description: `Analyze ${leadsData.length} leads across ${companiesMap.size} companies to determine contact priority and team assignments. Focus on identifying the most strategic leads to contact first within each company and which accounts warrant dedicated team member assignment.`,
      targets: [
        {
          strategic_analysis: "Comprehensive analysis of all leads considering company context, engagement history, and business potential"
        },
        {
          priority_leads: [
            {
              company: "Company name",
              primary_lead_id: "ID of the lead to contact first",
              primary_lead_name: "Name of the primary contact",
              priority_score: "Priority score (1-100)",
              reasoning: "Why this lead should be contacted first"
            }
          ]
        },
        {
          important_accounts: [
            {
              company: "Company name", 
              lead_id: "Lead ID for assignment",
              recommended_assignee_id: "Team member ID or 'unspecified'",
              recommended_assignee_name: "Team member name or 'To be determined'",
              account_value: "High/Medium/Low",
              assignment_reasoning: "Why this account needs dedicated assignment"
            }
          ]
        },
        {
          contact_recommendations: [
            {
              lead_id: "Lead ID",
              company: "Company name",
              contact_strategy: "Recommended approach for first contact",
              urgency: "High/Medium/Low",
              key_talking_points: "Main points to address"
            }
          ]
        }
      ],
      context: contextMessage,
      supervisor: [
        {
          agent_role: 'sales_manager',
          status: 'not_initialized'
        },
        {
          agent_role: 'account_manager',
          status: 'not_initialized'
        }
      ]
    });
    
    // Enviar el comando para procesamiento
    const commandId = await commandService.submitCommand(leadSelectionCommand);
    console.log(`📝 Comando de selección de leads creado con ID interno: ${commandId}`);
    
    // Esperar a que el comando se complete
    console.log(`⏳ Esperando que se complete el análisis de selección de leads...`);
    const { command: completedCommand, dbUuid, completed } = await waitForCommandCompletion(commandId);
    
    if (!completed || !completedCommand) {
      console.error(`❌ El comando de selección de leads no se completó correctamente`);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'COMMAND_FAILED', 
            message: 'Lead selection analysis did not complete successfully' 
          } 
        },
        { status: 500 }
      );
    }
    
    console.log(`✅ Comando de selección de leads completado exitosamente`);
    
    // Extraer resultados del comando
    let priorityLeads = [];
    let importantAccounts = [];
    let contactRecommendations = [];
    let strategicAnalysis = '';
    
    if (completedCommand.results && Array.isArray(completedCommand.results)) {
      for (const result of completedCommand.results) {
        if (result.strategic_analysis) {
          strategicAnalysis = result.strategic_analysis;
        }
        if (result.priority_leads && Array.isArray(result.priority_leads)) {
          priorityLeads = result.priority_leads;
        }
        if (result.important_accounts && Array.isArray(result.important_accounts)) {
          importantAccounts = result.important_accounts;
        }
        if (result.contact_recommendations && Array.isArray(result.contact_recommendations)) {
          contactRecommendations = result.contact_recommendations;
        }
      }
    }
    
    console.log(`📊 Resultados extraídos - Priority Leads: ${priorityLeads.length}, Important Accounts: ${importantAccounts.length}, Contact Recommendations: ${contactRecommendations.length}`);
    
    return NextResponse.json({
      success: true,
      data: {
        analysis: {
          total_leads_analyzed: leadsData.length,
          companies_analyzed: companiesMap.size,
          strategic_analysis: strategicAnalysis
        },
        priority_leads: priorityLeads,
        important_accounts: importantAccounts,
        contact_recommendations: contactRecommendations,
        team_members: teamMembers,
        site_channels: {
          has_channels: siteChannelsConfig.hasChannels,
          configured_channels: siteChannelsConfig.configuredChannels,
          channels_details: siteChannelsConfig.channelsDetails,
          warning: siteChannelsConfig.warning
        },
        command_info: {
          command_id: commandId,
          db_uuid: dbUuid
        }
      }
    });
    
  } catch (error) {
    console.error('Error general en la ruta de selección de leads:', error);
    
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'SYSTEM_ERROR', 
          message: 'An internal system error occurred' 
        } 
      },
      { status: 500 }
    );
  }
} 