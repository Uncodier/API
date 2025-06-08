import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { isValidUUID } from '@/lib/helpers/command-utils';
import { findGrowthMarketerAgent } from '@/lib/helpers/agent-finder';
import { executeGrowthMarketerSegmentAnalysis } from '@/lib/helpers/segment-commands';
import { createSegmentsFromResults } from '@/lib/helpers/segment-creators';

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
    const { siteId, userId, agent_id, segmentData = {} } = body;
    
    console.log('🔍 Parámetros extraídos:', { siteId, userId, agent_id, segmentData });
    
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
    
    // Find Growth Marketer agent for segment analysis
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
    
    console.log(`🎯 Growth Marketer encontrado: ${growthMarketerAgent.agentId}`);
    
    // Set fallback userId if still not defined
    if (!effectiveUserId) {
      effectiveUserId = growthMarketerAgent.userId || 'system';
    }
    
    // Crear contexto para el análisis de segmentos
    const segmentCount = segmentData.segmentCount || 5;
    const context = `Analyze audience segments for Site ID: ${siteId}

INSTRUCTIONS:
1. Identify the most profitable audience segments for this website.
2. Each segment should include:
   - A descriptive name that clearly identifies the audience
   - A comprehensive description of the segment characteristics
   - Estimated audience size and value potential
   - Target audience category that best fits the segment
   - Language preference of the segment
   - Profitability and confidence scores (0-1 scale)
   - Detailed audience profile for advertising platforms
   - Demographic, behavioral, and psychographic attributes
   - Monetization opportunities and recommended actions
3. Focus on segments with high commercial value and clear targeting potential
4. Consider the website's business model and target market
5. Generate ${segmentCount} segments ranked by profitability

Your segments should be actionable for marketing campaigns and have clear value propositions.`;
    
    // Execute Growth Marketer segment analysis command
    console.log(`📊 INICIANDO: Ejecutando análisis de segmentos con Growth Marketer...`);
    
    const { segmentAnalysisResults, analysisCommandUuid } = await executeGrowthMarketerSegmentAnalysis(
      siteId,
      growthMarketerAgent.agentId,
      effectiveUserId,
      context,
      segmentCount
    );

    if (!segmentAnalysisResults || segmentAnalysisResults.length === 0) {
      console.log(`❌ FALLO: Growth Marketer segment analysis falló - enviando error response`);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'SEGMENT_ANALYSIS_FAILED', 
            message: 'No se pudo obtener el análisis de segmentos del Growth Marketer' 
          } 
        },
        { status: 500 }
      );
    }

    console.log(`✅ COMPLETADO: Análisis de segmentos completado con ${segmentAnalysisResults.length} segmentos identificados`);
    console.log(`🔑 Analysis Command UUID: ${analysisCommandUuid}`);
    console.log(`💾 INICIANDO GUARDADO: Guardando segmentos en base de datos...`);

    // Create segments from Growth Marketer results
    const createdSegments = await createSegmentsFromResults(
      segmentAnalysisResults, 
      siteId, 
      effectiveUserId, 
      analysisCommandUuid
    );
    
    if (createdSegments.length === 0) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'NO_SEGMENTS_CREATED', 
            message: 'No se pudieron crear segmentos a partir de los resultados del Growth Marketer' 
          } 
        },
        { status: 400 }
      );
    }
    
    console.log(`🎉 PROCESO COMPLETO: Enviando respuesta SUCCESS al cliente después de comando + guardado`);
    console.log(`📊 Resumen final: ${createdSegments.length} segmentos creados`);
    
    // Devolver respuesta exitosa con los segmentos creados
    return NextResponse.json(
      { 
        success: true, 
        data: { 
          command_id: analysisCommandUuid,
          site_id: siteId,
          url: null, // Se podría obtener de la tabla sites si es necesario
          segmentsAnalyzed: segmentAnalysisResults.length,
          segmentsCreated: createdSegments.length,
          segments: createdSegments,
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