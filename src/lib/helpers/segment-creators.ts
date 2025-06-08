import { supabaseAdmin } from '@/lib/database/supabase-client';
import { isValidUUID } from './command-utils';

// Helper function to generate a unique segment ID
function generateSegmentId(prefix: string = 'seg'): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}_${timestamp}_${random}`;
}

// Helper function to parse numeric values from strings
function parseNumericValue(value: string | number | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    // Remove currency symbols, commas, and other non-numeric characters except dots
    const cleaned = value.replace(/[^\d.-]/g, '');
    const parsed = parseFloat(cleaned);
    return isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

// Create segments from Growth Marketer analysis results
export async function createSegmentsFromResults(
  segmentAnalysisResults: any[], 
  siteId: string, 
  userId: string, 
  analysisCommandUuid: string | null
): Promise<any[]> {
  const createdSegments: any[] = [];
  
  console.log(`🔄 Procesando resultados de Growth Marketer para crear segmentos...`);
  console.log(`🔑 Analysis Command UUID: ${analysisCommandUuid}`);
  console.log(`📝 Creando segmentos para sitio: ${siteId}`);
  
  for (const segmentData of segmentAnalysisResults) {
    try {
      // Generate unique segment ID if not provided
      const segmentId = segmentData.id || generateSegmentId();
      
      // Prepare segment data for database insertion
      const dbSegmentData = {
        id: segmentId,
        name: segmentData.name || 'Unknown Segment',
        description: segmentData.description || '',
        summary: segmentData.summary || '',
        estimated_size: segmentData.estimatedSize || '0',
        estimated_value: parseNumericValue(segmentData.estimatedValue) || 0,
        profitability_score: typeof segmentData.profitabilityScore === 'number' 
          ? segmentData.profitabilityScore 
          : parseFloat(segmentData.profitabilityScore) || 0,
        confidence_score: typeof segmentData.confidenceScore === 'number' 
          ? segmentData.confidenceScore 
          : parseFloat(segmentData.confidenceScore) || 0,
        target_audience: Array.isArray(segmentData.targetAudience) 
          ? segmentData.targetAudience.join(', ') 
          : segmentData.targetAudience || '',
        language: segmentData.language || 'en',
        attributes: segmentData.attributes || {},
        audience_profile: segmentData.audienceProfile || {},
        site_id: siteId,
        user_id: userId,
        analysis: segmentData.audienceProfile 
          ? [{ type: 'audienceProfile', data: segmentData.audienceProfile }]
          : [],
        topics: [], // Can be enhanced later
        url: null, // Can be obtained from sites table if needed
        is_active: true
      };
      
      // Add monetization opportunities and recommended actions to analysis
      if (segmentData.monetizationOpportunities || segmentData.recommendedActions) {
        const additionalAnalysis: any = {};
        
        if (segmentData.monetizationOpportunities) {
          additionalAnalysis.monetizationOpportunities = segmentData.monetizationOpportunities;
        }
        
        if (segmentData.recommendedActions) {
          additionalAnalysis.recommendedActions = segmentData.recommendedActions;
        }
        
        dbSegmentData.analysis.push({ 
          type: 'marketingInsights', 
          data: additionalAnalysis 
        });
      }
      
      console.log(`📝 Guardando segmento: ${segmentData.name}`);
      console.log(`🔍 Segment data prepared:`, JSON.stringify(dbSegmentData, null, 2));
      
      // Insert segment into database
      const { data: createdSegment, error: segmentError } = await supabaseAdmin
        .from('segments')
        .insert(dbSegmentData)
        .select()
        .single();
      
      if (segmentError) {
        console.error(`❌ Error al crear segmento ${segmentData.name}:`, segmentError);
        continue;
      }
      
      if (createdSegment) {
        console.log(`✅ Segmento creado con ID: ${createdSegment.id}`);
        
        // Format the created segment for response
        const formattedSegment = {
          id: createdSegment.id,
          name: createdSegment.name,
          description: createdSegment.description,
          summary: createdSegment.summary,
          estimatedSize: createdSegment.estimated_size,
          estimatedValue: createdSegment.estimated_value?.toString() || '0',
          profitabilityScore: createdSegment.profitability_score || 0,
          confidenceScore: createdSegment.confidence_score || 0,
          targetAudience: createdSegment.target_audience,
          language: createdSegment.language,
          attributes: createdSegment.attributes,
          audienceProfile: createdSegment.audience_profile,
          createdInDatabase: true,
          databaseId: createdSegment.id,
          created_at: createdSegment.created_at,
          updated_at: createdSegment.updated_at
        };
        
        createdSegments.push(formattedSegment);
      }
      
    } catch (error) {
      console.error(`❌ Error al procesar segmento ${segmentData.name}:`, error);
      continue;
    }
  }
  
  console.log(`📊 Resumen: ${createdSegments.length} segmentos creados exitosamente`);
  return createdSegments;
}

// Update segments with ICP analysis results
export async function updateSegmentsWithIcpResults(
  icpAnalysisResults: any[], 
  existingSegments: any[],
  icpCommandUuid: string | null
): Promise<any[]> {
  const updatedSegments: any[] = [];
  
  console.log(`🔄 Procesando resultados de análisis ICP para actualizar segmentos...`);
  console.log(`🔑 ICP Command UUID: ${icpCommandUuid}`);
  console.log(`📝 Actualizando ${existingSegments.length} segmentos existentes`);
  
  for (const icpData of icpAnalysisResults) {
    try {
      const segmentId = icpData.segment_id;
      
      if (!segmentId || !isValidUUID(segmentId)) {
        console.log(`⚠️ Segment ID inválido en análisis ICP: ${segmentId}`);
        continue;
      }
      
      // Find the existing segment
      const existingSegment = existingSegments.find(s => s.id === segmentId);
      if (!existingSegment) {
        console.log(`⚠️ Segmento no encontrado para ID: ${segmentId}`);
        continue;
      }
      
      console.log(`📝 Actualizando segmento: ${existingSegment.name}`);
      
      // Prepare enhanced analysis data
      const currentAnalysis = Array.isArray(existingSegment.analysis) 
        ? existingSegment.analysis 
        : [];
      
      // Add ICP enhancements to the analysis
      const icpEnhancement = {
        type: 'icpAnalysis',
        data: icpData.icp_enhancements || {},
        timestamp: new Date().toISOString(),
        command_uuid: icpCommandUuid
      };
      
      const updatedAnalysis = [...currentAnalysis, icpEnhancement];
      
      // Update segment in database
      const { data: updatedSegment, error: updateError } = await supabaseAdmin
        .from('segments')
        .update({ 
          analysis: updatedAnalysis,
          updated_at: new Date().toISOString()
        })
        .eq('id', segmentId)
        .select()
        .single();
      
      if (updateError) {
        console.error(`❌ Error al actualizar segmento ${segmentId}:`, updateError);
        continue;
      }
      
      if (updatedSegment) {
        console.log(`✅ Segmento actualizado: ${updatedSegment.id}`);
        
        // Format the updated segment for response
        const formattedSegment = {
          id: updatedSegment.id,
          name: updatedSegment.name,
          description: updatedSegment.description,
          summary: updatedSegment.summary,
          estimatedSize: updatedSegment.estimated_size,
          estimatedValue: updatedSegment.estimated_value?.toString() || '0',
          profitabilityScore: updatedSegment.profitability_score || 0,
          confidenceScore: updatedSegment.confidence_score || 0,
          targetAudience: updatedSegment.target_audience,
          language: updatedSegment.language,
          attributes: updatedSegment.attributes,
          audienceProfile: updatedSegment.audience_profile,
          analysis: updatedSegment.analysis,
          icpEnhanced: true,
          icpEnhancementData: icpData.icp_enhancements,
          updated_at: updatedSegment.updated_at
        };
        
        updatedSegments.push(formattedSegment);
      }
      
    } catch (error) {
      console.error(`❌ Error al procesar análisis ICP para segmento ${icpData.segment_id}:`, error);
      continue;
    }
  }
  
  console.log(`📊 Resumen: ${updatedSegments.length} segmentos actualizados con análisis ICP`);
  return updatedSegments;
} 