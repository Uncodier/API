import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getSegmentsBySite } from '@/lib/database/segment-db';
import { getLeadInfo, buildEnrichedContext } from '@/lib/helpers/lead-context-helper';

// Configurar timeout máximo a 5 minutos (300 segundos)
// Máximo para plan Pro de Vercel
export const maxDuration = 300;

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Función para encontrar agente con role "Data Analyst"
async function findDataAnalystAgent(siteId: string): Promise<{agentId: string, userId: string} | null> {
  try {
    if (!siteId || !isValidUUID(siteId)) {
      console.error(`❌ Invalid site_id for Data Analyst agent search: ${siteId}`);
      return null;
    }
    
    const { data, error } = await supabaseAdmin
      .from('agents')
      .select('id, user_id')
      .eq('site_id', siteId)
      .eq('role', 'Data Analyst')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1);
    
    if (error) {
      console.error('Error al buscar agente con role "Data Analyst":', error);
      return null;
    }
    
    if (!data || data.length === 0) {
      console.log(`⚠️ No se encontró ningún agente con role "Data Analyst" activo para el sitio: ${siteId}`);
      return null;
    }
    
    return {
      agentId: data[0].id,
      userId: data[0].user_id
    };
  } catch (error) {
    console.error('Error al buscar agente Data Analyst:', error);
    return null;
  }
}

// Función para actualizar el segment_id del lead
async function updateLeadSegment(leadId: string, segmentId: string): Promise<boolean> {
  try {
    const { error } = await supabaseAdmin
      .from('leads')
      .update({ 
        segment_id: segmentId,
        updated_at: new Date().toISOString()
      })
      .eq('id', leadId);
    
    if (error) {
      console.error('Error al actualizar segmento del lead:', error);
      return false;
    }
    
    console.log(`✅ Lead ${leadId} asignado al segmento ${segmentId}`);
    return true;
  } catch (error) {
    console.error('Error al actualizar segmento del lead:', error);
    return false;
  }
}

// Inicializar el sistema de comandos
const processorInitializer = ProcessorInitializer.getInstance();
processorInitializer.initialize();
const commandService = processorInitializer.getCommandService();

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { 
      lead_id, 
      site_id,
      auto_assign = true
    } = body;
    
    // Validar parámetros requeridos
    if (!lead_id || !site_id) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: 'lead_id and site_id are required' 
          } 
        },
        { status: 400 }
      );
    }
    
    if (!isValidUUID(lead_id) || !isValidUUID(site_id)) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: 'lead_id and site_id must be valid UUIDs' 
          } 
        },
        { status: 400 }
      );
    }
    
    // Buscar agente Data Analyst
    const dataAnalystAgent = await findDataAnalystAgent(site_id);
    if (!dataAnalystAgent) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'DATA_ANALYST_NOT_FOUND', 
            message: 'No se encontró un agente con role "Data Analyst" para este sitio' 
          } 
        },
        { status: 404 }
      );
    }
    
    console.log(`🎯 Iniciando segmentación para lead: ${lead_id} en sitio: ${site_id}`);
    
    // Obtener información completa del lead
    const leadInfo = await getLeadInfo(lead_id);
    if (!leadInfo) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'LEAD_NOT_FOUND', 
            message: 'No se encontró el lead especificado' 
          } 
        },
        { status: 404 }
      );
    }
    
    // Obtener todos los segmentos del sitio
    const segments = await getSegmentsBySite(site_id, dataAnalystAgent.userId);
    if (!segments || segments.length === 0) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'NO_SEGMENTS_FOUND', 
            message: 'No se encontraron segmentos para este sitio' 
          } 
        },
        { status: 404 }
      );
    }
    
    console.log(`📊 Encontrados ${segments.length} segmentos para análisis`);
    
    // Construir contexto enriquecido del lead
    const enrichedContext = await buildEnrichedContext(site_id, lead_id);
    
    // Crear contexto de análisis para la segmentación
    const segmentationContext = `Lead Segmentation Analysis Request:

LEAD INFORMATION:
- Lead ID: ${lead_id}
- Name: ${leadInfo.name || 'N/A'}
- Email: ${leadInfo.email || 'N/A'}
- Phone: ${leadInfo.phone || 'N/A'}
- Position: ${leadInfo.position || 'N/A'}
- Status: ${leadInfo.status || 'N/A'}
- Origin: ${leadInfo.origin || 'N/A'}
- Company: ${leadInfo.company ? JSON.stringify(leadInfo.company) : 'N/A'}
- Social Networks: ${leadInfo.social_networks ? JSON.stringify(leadInfo.social_networks) : 'N/A'}
- Address: ${leadInfo.address ? JSON.stringify(leadInfo.address) : 'N/A'}
- Subscription: ${leadInfo.subscription ? JSON.stringify(leadInfo.subscription) : 'N/A'}
- Attribution: ${leadInfo.attribution ? JSON.stringify(leadInfo.attribution) : 'N/A'}
- Metadata: ${leadInfo.metadata ? JSON.stringify(leadInfo.metadata) : 'N/A'}
- Language: ${leadInfo.language || 'N/A'}
- Current Segment: ${leadInfo.segment_id || 'Not assigned'}

AVAILABLE SEGMENTS (${segments.length} total):
${segments.map((segment, index) => `
${index + 1}. Segment: ${segment.name}
   - ID: ${segment.id}
   - Description: ${segment.description || 'N/A'}
   - Audience: ${segment.audience || 'N/A'}
   - Language: ${segment.language}
   - Size: ${segment.size || 0}
   - Engagement: ${segment.engagement || 0}
   - Estimated Value: ${segment.estimated_value || 0}
   - Active: ${segment.is_active ? 'Yes' : 'No'}
   - ICP: ${segment.icp ? JSON.stringify(segment.icp) : 'N/A'}
   - Topics: ${segment.topics ? JSON.stringify(segment.topics) : 'N/A'}
   - Analysis: ${segment.analysis ? JSON.stringify(segment.analysis) : 'N/A'}
`).join('')}

ENRICHED CONTEXT:
${enrichedContext}

Please analyze the lead information against all available segments and determine the most suitable segment assignment. Consider factors like demographics, company information, interests, behavior, language, and any other relevant characteristics that align with segment profiles.`;
    
    const commandData = CommandFactory.createCommand({
      task: 'analyze lead for optimal segment assignment',
      userId: dataAnalystAgent.userId,
      description: `Lead Segmentation Analysis for lead ${lead_id} against ${segments.length} available segments`,
      agentId: dataAnalystAgent.agentId,
      site_id: site_id,
      context: segmentationContext.trim(),
      targets: [
        {
          segmentation_analysis: {
            recommended_segment_id: 'string',
            recommended_segment_name: 'string',
            confidence_score: 'number',
            reasoning: 'string',
            key_matching_factors: 'array',
            alternative_segments: 'array',
            segment_fit_analysis: {
              demographic_match: 'number',
              behavioral_match: 'number', 
              value_alignment: 'number',
              language_match: 'number',
              overall_fit_score: 'number'
            },
            recommendations: 'array'
          }
        }
      ],
      tools: [],
      supervisor: [
        {
          agent_role: 'segmentation_manager',
          status: 'not_initialized'
        }
      ],
    });
    
    console.log(`🔧 Creando comando de segmentación de lead`);
    
    // Enviar comando para ejecución
    const internalCommandId = await commandService.submitCommand(commandData);
    
    console.log(`📝 Comando de segmentación creado: ${internalCommandId}`);
    
    // Obtener el UUID real del comando buscando en la base de datos
    let realCommandId = null;
    try {
      // Buscar el comando más reciente para este agente
      const { data: recentCommands, error } = await supabaseAdmin
        .from('commands')
        .select('id')
        .eq('agent_id', dataAnalystAgent.agentId)
        .eq('description', `Lead Segmentation Analysis for lead ${lead_id} against ${segments.length} available segments`)
        .order('created_at', { ascending: false })
        .limit(1);
      
      if (!error && recentCommands && recentCommands.length > 0) {
        realCommandId = recentCommands[0].id;
        console.log(`🔍 UUID real del comando encontrado: ${realCommandId}`);
      }
    } catch (error) {
      console.log('No se pudo obtener el UUID del comando desde BD, usando ID interno');
    }
    
    // Si no tenemos el UUID real, usar el ID interno
    const commandIdToSearch = realCommandId || internalCommandId;
    
    // Esperar a que el comando se complete
    let completedCommand = null;
    const maxRetries = 580; // 580 intentos = 290 segundos máximo (~4.8 minutos)
    const retryDelay = 500; // 500ms entre intentos
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Buscar comando en base de datos por ID
        const { data: commandData, error } = await supabaseAdmin
          .from('commands')
          .select('*')
          .eq('id', commandIdToSearch)
          .single();
        
        if (!error && commandData) {
          if (commandData.status === 'completed') {
            completedCommand = commandData;
            console.log(`✅ Comando completado después de ${attempt + 1} intentos`);
            break;
          } else if (commandData.status === 'failed') {
            console.error(`❌ Comando falló después de ${attempt + 1} intentos`);
            return NextResponse.json(
              { 
                success: false, 
                error: { 
                  code: 'COMMAND_EXECUTION_FAILED', 
                  message: 'Lead segmentation command failed to execute',
                  commandId: commandIdToSearch
                } 
              },
              { status: 500 }
            );
          }
        }
        
        // Si no está completado, esperar antes del siguiente intento
        if (attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      } catch (error) {
        console.log(`Intento ${attempt + 1}/${maxRetries}: Comando aún procesándose...`);
        if (attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
    }
    
    if (!completedCommand) {
      console.log('⚠️ Comando no completado después del tiempo máximo de espera');
    }
    
    // Preparar respuesta
    const responseData: any = {
      commandId: commandIdToSearch,
      status: completedCommand ? 'completed' : 'timeout',
      message: completedCommand ? 'Lead segmentation completed' : 'Lead segmentation timed out - command may still be processing',
      agent_id: dataAnalystAgent.agentId,
      lead_id: lead_id,
      site_id: site_id,
      segments_analyzed: segments.length,
      current_segment: leadInfo.segment_id || null,
      timestamp: new Date().toISOString()
    };

    // Si el comando está completado, extraer los resultados del análisis
    let segmentationResult = null;
    if (completedCommand && completedCommand.results) {
      try {
        const results = Array.isArray(completedCommand.results) ? completedCommand.results : [completedCommand.results];
        const resultWithSegmentation = results.find((result: any) => result.segmentation_analysis);
        
        if (resultWithSegmentation) {
          segmentationResult = resultWithSegmentation.segmentation_analysis;
          responseData.segmentation_analysis = segmentationResult;
          
          // Si auto_assign está habilitado y tenemos una recomendación, actualizar el lead
          if (auto_assign && segmentationResult.recommended_segment_id) {
            const assignmentSuccess = await updateLeadSegment(lead_id, segmentationResult.recommended_segment_id);
            responseData.segment_assigned = assignmentSuccess;
            responseData.new_segment_id = segmentationResult.recommended_segment_id;
            
            if (assignmentSuccess) {
              console.log(`✅ Lead ${lead_id} automáticamente asignado al segmento ${segmentationResult.recommended_segment_id}`);
            } else {
              console.error(`❌ Error al asignar automáticamente el lead ${lead_id} al segmento ${segmentationResult.recommended_segment_id}`);
            }
          }
        }
      } catch (error) {
        console.error('Error extracting segmentation_analysis from completed command:', error);
      }
    }
    
    // Agregar información de segmentos disponibles
    responseData.available_segments = segments.map(segment => ({
      id: segment.id,
      name: segment.name,
      description: segment.description,
      audience: segment.audience,
      language: segment.language,
      is_active: segment.is_active,
      size: segment.size,
      engagement: segment.engagement,
      estimated_value: segment.estimated_value
    }));
    
    return NextResponse.json({
      success: true,
      data: responseData
    });
    
  } catch (error) {
    console.error('❌ Error en ruta leadSegmentation:', error);
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