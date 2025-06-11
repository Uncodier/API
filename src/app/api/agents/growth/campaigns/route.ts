import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { isValidUUID } from '@/lib/helpers/command-utils';
import { findGrowthMarketerAgent } from '@/lib/helpers/agent-finder';
import { executeGrowthMarketerCampaignPlanning } from '@/lib/helpers/campaign-commands';
import { createCampaignsFromResults } from '@/lib/helpers/campaign-creators';
import { getSegmentsSummaryForCampaigns, formatSegmentsContextForCampaigns } from '@/lib/helpers/segment-context';

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
    const { siteId, userId, agent_id } = body;
    
    console.log('🔍 Parámetros extraídos:', { siteId, userId, agent_id });
    
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
    
    // Find Growth Marketer agent for campaign planning
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
    
    // Obtener resumen de segmentos para incluir en el contexto
    console.log(`📊 Obteniendo resumen de segmentos para el sitio ${siteId}...`);
    const segmentsSummary = await getSegmentsSummaryForCampaigns(siteId);
    const segmentsContext = formatSegmentsContextForCampaigns(segmentsSummary);
    
    // Crear contexto enriquecido con información de segmentos
    const context = `Generate strategic marketing campaign ideas for Site ID: ${siteId}

${segmentsContext}

INSTRUCTIONS:
1. Create detailed and actionable marketing campaigns with clear objectives.
2. Each campaign should include:
   - A descriptive title that reflects the campaign's purpose
   - A comprehensive description explaining the strategy and goals
   - Appropriate type (inbound, outbound, branding, etc.)
   - Realistic priority level based on business impact
   - Reasonable budget and revenue projections
   - Realistic due date for completion
3. Focus on campaigns that drive measurable business growth and ROI
4. Consider the target audience and market positioning from the available segments
5. Plan campaigns that work synergistically together
6. Always consider founder generated content for tiktoks, instagram reels, etc.
7. LEVERAGE THE SEGMENT DATA: Use the pain points, interests, and preferred channels identified in the segments to create more targeted and effective campaigns
8. CREATE SEGMENT-SPECIFIC CAMPAIGNS: Consider creating campaigns specifically targeting individual segments when appropriate

Your campaigns should be strategic, measurable, and aligned with business growth objectives. Use the audience segment insights to ensure maximum campaign relevance and effectiveness.

IMPORTANT:
- If the campaign is targeting a paid channel, assign a specific budget for the channel in a task, example: 
  50 usd to design, copys, setup, etc., 100 usd to run the ads, total 150 usd for the campaign.
- Consider the specific interests and pain points from each segment when designing campaigns
- Use the preferred channels information to select the most effective distribution methods
`;
    
    // Execute Growth Marketer campaign planning command
    console.log(`📊 INICIANDO: Ejecutando planificación de campañas con Growth Marketer...`);
    
    const { campaignPlanningResults, planningCommandUuid } = await executeGrowthMarketerCampaignPlanning(
      siteId,
      growthMarketerAgent.agentId,
      effectiveUserId,
      context
    );

    if (!campaignPlanningResults || campaignPlanningResults.length === 0) {
      console.log(`❌ FALLO: Growth Marketer campaign planning falló - enviando error response`);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'CAMPAIGN_PLANNING_FAILED', 
            message: 'No se pudo obtener la planificación de campañas del Growth Marketer' 
          } 
        },
        { status: 500 }
      );
    }

    console.log(`✅ COMPLETADO: Planificación de campañas completada con ${campaignPlanningResults.length} campañas estratégicas`);
    console.log(`🔑 Planning Command UUID: ${planningCommandUuid}`);
    console.log(`💾 INICIANDO GUARDADO: Guardando campañas en base de datos...`);

    // Create campaigns from Growth Marketer results
    const createdCampaigns = await createCampaignsFromResults(
      campaignPlanningResults, 
      siteId, 
      effectiveUserId, 
      planningCommandUuid
    );
    
    if (createdCampaigns.length === 0) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'NO_CAMPAIGNS_CREATED', 
            message: 'No se pudieron crear campañas a partir de los resultados del Growth Marketer' 
          } 
        },
        { status: 400 }
      );
    }
    
    console.log(`🎉 PROCESO COMPLETO: Enviando respuesta SUCCESS al cliente después de comando + guardado`);
    console.log(`📊 Resumen final: ${createdCampaigns.length} campañas creadas`);
    
    // Devolver respuesta exitosa con las campañas creadas
    return NextResponse.json(
      { 
        success: true, 
        data: { 
          campaigns: createdCampaigns
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