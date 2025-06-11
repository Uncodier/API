import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { isValidUUID } from '@/lib/helpers/command-utils';
import { findGrowthMarketerAgent } from '@/lib/helpers/agent-finder';
import { executeGrowthMarketerIcpAnalysis } from '@/lib/helpers/segment-commands';
import { updateSegmentsWithIcpResults } from '@/lib/helpers/segment-creators';

export async function POST(request: Request) {
  try {
    let body;
    try {
      body = await request.json();
      console.log('📦 Cuerpo de la solicitud recibido:', JSON.stringify(body, null, 2));
    } catch (parseError) {
      console.error('❌ Error al analizar el cuerpo de la solicitud:', parseError);
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_JSON', message: 'Could not parse request body as JSON' } },
        { status: 400 }
      );
    }
    
    // Extraer parámetros directamente como están en la solicitud
    const { siteId, userId, agent_id, segmentIds = [] } = body;
    
    console.log('🔍 Parámetros extraídos:', { siteId, userId, agent_id, segmentIds });
    
    // Validar siteId requerido
    if (!siteId) {
      console.log('❌ Error: siteId requerido no proporcionado');
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'siteId is required' } },
        { status: 400 }
      );
    }
    
    // Make sure siteId is a valid UUID
    if (!isValidUUID(siteId)) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'siteId must be a valid UUID' } },
        { status: 400 }
      );
    }
    
    // Validar que se proporcionen segmentIds
    if (!segmentIds || !Array.isArray(segmentIds) || segmentIds.length === 0) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'segmentIds array is required and cannot be empty' } },
        { status: 400 }
      );
    }
    
    // Validar que todos los segmentIds sean UUIDs válidos
    for (const segmentId of segmentIds) {
      if (!isValidUUID(segmentId)) {
        return NextResponse.json(
          { success: false, error: { code: 'INVALID_REQUEST', message: `Invalid segment ID: ${segmentId}` } },
          { status: 400 }
        );
      }
    }
    
    // Si no hay userId, verificar el sitio y buscar el usuario asociado
    let effectiveUserId = userId;
    if (!effectiveUserId) {
      try {
        const { data: siteData, error: siteError } = await supabaseAdmin
          .from('sites')
          .select('user_id')
          .eq('id', siteId)
          .single();
        
        if (siteError || !siteData?.user_id) {
          console.log(`❌ Error: El sitio con ID ${siteId} no existe o no tiene usuario asociado`);
          return NextResponse.json(
            { success: false, error: { code: 'SITE_NOT_FOUND', message: `Site not found or has no associated user` } },
            { status: 404 }
          );
        }
        
        effectiveUserId = siteData.user_id;
        console.log(`👤 UserId obtenido del sitio: ${effectiveUserId}`);
      } catch (error) {
        console.error('Error al verificar el sitio:', error);
        return NextResponse.json(
          { success: false, error: { code: 'SITE_VERIFICATION_FAILED', message: 'Failed to verify site existence' } },
          { status: 500 }
        );
      }
    }
    
    // Verificar que los segmentos existen y pertenecen al sitio
    const { data: existingSegments, error: segmentsError } = await supabaseAdmin
      .from('segments')
      .select('id, name, description, site_id, analysis')
      .eq('site_id', siteId)
      .in('id', segmentIds);
    
    if (segmentsError) {
      console.error('Error al verificar segmentos:', segmentsError);
      return NextResponse.json(
        { success: false, error: { code: 'SEGMENTS_VERIFICATION_FAILED', message: 'Failed to verify segments existence' } },
        { status: 500 }
      );
    }
    
    if (!existingSegments || existingSegments.length === 0) {
      return NextResponse.json(
        { success: false, error: { code: 'SEGMENTS_NOT_FOUND', message: 'No segments found for the provided IDs and site' } },
        { status: 404 }
      );
    }
    
    if (existingSegments.length !== segmentIds.length) {
      const foundIds = existingSegments.map(s => s.id);
      const missingIds = segmentIds.filter(id => !foundIds.includes(id));
      return NextResponse.json(
        { success: false, error: { code: 'SEGMENTS_NOT_FOUND', message: `Some segments not found: ${missingIds.join(', ')}` } },
        { status: 404 }
      );
    }
    
    console.log(`✅ Se encontraron ${existingSegments.length} segmentos para análisis ICP`);
    
    // Determine agent to use - prioritize provided agent_id, fallback to Growth Marketer
    let selectedAgent = null;
    if (agent_id && isValidUUID(agent_id)) {
      // Verify the provided agent exists and belongs to the site
      const { data: agentData, error: agentError } = await supabaseAdmin
        .from('agents')
        .select('id, user_id, role, status')
        .eq('id', agent_id)
        .eq('site_id', siteId)
        .eq('status', 'active')
        .single();
      
      if (!agentError && agentData) {
        selectedAgent = {
          agentId: agentData.id,
          userId: agentData.user_id
        };
        console.log(`🎯 Usando agente proporcionado: ${selectedAgent.agentId} (rol: ${agentData.role})`);
      } else {
        console.log(`⚠️ Agente proporcionado ${agent_id} no válido, buscando Growth Marketer`);
      }
    }
    
    // If no valid agent provided, find Growth Marketer agent for ICP analysis
    if (!selectedAgent) {
      const growthMarketerAgent = await findGrowthMarketerAgent(siteId);
      
      if (!growthMarketerAgent) {
        return NextResponse.json(
          { 
            success: false, 
            error: { 
              code: 'GROWTH_MARKETER_NOT_FOUND', 
              message: 'No se encontró un agente con rol "Growth Marketer" para este sitio' 
            } 
          },
          { status: 404 }
        );
      }
      
      selectedAgent = growthMarketerAgent;
      console.log(`🎯 Growth Marketer encontrado: ${selectedAgent.agentId}`);
    }
    
    // Set fallback userId if still not defined
    if (!effectiveUserId) {
      effectiveUserId = selectedAgent.userId || 'system';
    }
    
    // Crear contexto para el análisis ICP
    const context = `Perform detailed ICP (Ideal Customer Profile) analysis for existing audience segments from Site ID: ${siteId}

EXISTING SEGMENTS TO ANALYZE:
${existingSegments.map((segment, index) => `
SEGMENT ${index + 1}: ${segment.name}
- ID: ${segment.id}
- Description: ${segment.description || 'N/A'}
- Current Analysis: ${JSON.stringify(segment.analysis) || 'N/A'}
`).join('\n')}

INSTRUCTIONS:
1. For each existing segment, create a comprehensive ICP analysis that includes:
   - Detailed demographic profile (age, income, education, location)
   - Psychographic characteristics (values, interests, lifestyle)
   - Behavioral patterns (buying behavior, media consumption, decision-making process)
   - Pain points and challenges they face
   - Goals and aspirations
   - Preferred communication channels and messaging
   - Buying journey and decision factors
   - Budget and purchasing power
   - Technology adoption and digital behavior
   - Competitive analysis and alternative solutions they consider

2. Enhance the existing segment data with:
   - More precise targeting criteria for ad platforms
   - Advanced audience lookalike modeling parameters
   - Cross-platform audience mapping
   - Content preferences and engagement patterns
   - Optimal outreach timing and frequency
   - Personalization opportunities

3. Provide actionable insights for:
   - Marketing message optimization
   - Channel strategy refinement
   - Product positioning improvements
   - Sales approach customization
   - Customer experience enhancement

Your ICP analysis should significantly enhance the targeting precision and marketing effectiveness for each segment.`;
    
    // Execute Growth Marketer ICP analysis command
    console.log(`📊 INICIANDO: Ejecutando análisis ICP con agente seleccionado...`);
    
    const { icpAnalysisResults, icpCommandUuid } = await executeGrowthMarketerIcpAnalysis(
      siteId,
      selectedAgent.agentId,
      effectiveUserId,
      context,
      existingSegments
    );

    if (!icpAnalysisResults || icpAnalysisResults.length === 0) {
      console.log(`❌ FALLO: Growth Marketer ICP analysis falló - enviando error response`);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'ICP_ANALYSIS_FAILED', 
            message: 'No se pudo obtener el análisis ICP del Growth Marketer' 
          } 
        },
        { status: 500 }
      );
    }

    console.log(`✅ COMPLETADO: Análisis ICP completado para ${icpAnalysisResults.length} segmentos`);
    console.log(`🔑 ICP Command UUID: ${icpCommandUuid}`);
    console.log(`💾 INICIANDO GUARDADO: Actualizando segmentos con análisis ICP...`);

    // Update segments with ICP analysis results
    let updatedSegments;
    try {
      updatedSegments = await updateSegmentsWithIcpResults(
        icpAnalysisResults, 
        existingSegments,
        icpCommandUuid
      );
      
      console.log(`🔍 DEBUG: Segmentos actualizados resultado:`, updatedSegments.length);
      
    } catch (updateError: any) {
      console.error('❌ Error durante la actualización de segmentos:', updateError);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'SEGMENT_UPDATE_ERROR', 
            message: `Error al actualizar segmentos: ${updateError?.message || 'Error desconocido'}` 
          } 
        },
        { status: 500 }
      );
    }
    
    if (!updatedSegments || updatedSegments.length === 0) {
      console.log(`⚠️ ADVERTENCIA: No se actualizaron segmentos. Resultado:`, updatedSegments);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'NO_SEGMENTS_UPDATED', 
            message: 'No se pudieron actualizar segmentos con el análisis ICP' 
          } 
        },
        { status: 400 }
      );
    }
    
    console.log(`🎉 PROCESO COMPLETO: Enviando respuesta SUCCESS al cliente después de comando + actualización`);
    console.log(`📊 Resumen final: ${updatedSegments.length} segmentos actualizados con análisis ICP`);
    
    // Devolver respuesta exitosa con los segmentos actualizados
    return NextResponse.json(
      { 
        success: true, 
        data: { 
          command_id: icpCommandUuid,
          site_id: siteId,
          segmentsAnalyzed: icpAnalysisResults.length,
          segmentsUpdated: updatedSegments.length,
          segments: updatedSegments,
          saved_to_database: true
        } 
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('Error al procesar la solicitud:', error);
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'An error occurred while processing the request' } },
      { status: 500 }
    );
  }
} 