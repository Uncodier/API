import { supabaseAdmin } from '@/lib/database/supabase-client';
import { isValidUUID } from './command-utils';

// Helper function to generate a unique segment ID
function generateSegmentId(prefix: string = 'seg'): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}_${timestamp}_${random}`;
}

// Helper function to parse numeric values from strings
function parseNumericValue(value: any): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const cleanValue = value.replace(/[^0-9.-]/g, '');
    const parsed = parseFloat(cleanValue);
    return isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

// Helper function to map targetAudience to valid segment_audience enum values
function mapTargetAudienceToEnum(targetAudience: string | string[]): string {
  const audienceValue = Array.isArray(targetAudience) ? targetAudience[0] : targetAudience;
  
  // Mapping of common values to enum values based on documentation
  const audienceMapping: { [key: string]: string } = {
    'media_entertainment': 'media_entertainment',
    'enterprise': 'enterprise',
    'smb': 'smb',
    'startup': 'startup',
    'b2b_saas': 'tech',
    'e_commerce': 'e_commerce',
    'tech': 'tech',
    'finance': 'finance',
    'healthcare': 'healthcare',
    'education': 'education',
    'professional': 'professional',
    'manufacturing': 'professional',
    'retail': 'e_commerce',
    'real_estate': 'professional',
    'hospitality': 'professional',
    'automotive': 'professional',
    'media': 'media_entertainment',
    'telecom': 'tech',
    'energy': 'enterprise',
    'agriculture': 'professional',
    'construction': 'professional',
    'logistics': 'professional',
    'government': 'professional',
    'nonprofit': 'professional',
    'legal': 'professional',
    'pharma': 'healthcare',
    'insurance': 'finance',
    'consulting': 'professional',
    'research': 'education',
    'aerospace': 'tech',
    'gaming': 'tech',
    'consultants_freelancers': 'professional', // Fix for the error case
    'content_creators': 'media_entertainment',
    'saas_users': 'tech',
    'developers': 'tech',
    'marketers': 'professional'
  };
  
  return audienceMapping[audienceValue] || 'professional'; // Default to 'professional' if not found
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
      // DON'T generate or use manual segment ID - let database auto-generate UUID
      
      // Prepare segment data for database insertion
      const dbSegmentData = {
        name: segmentData.name || 'Unknown Segment',
        description: segmentData.description || '',
        audience: mapTargetAudienceToEnum(segmentData.targetAudience), // Map to valid enum value
        size: parseNumericValue(segmentData.estimatedSize) || 0,
        engagement: 0, // Default engagement value
        is_active: true,
        site_id: siteId,
        user_id: userId,
        language: segmentData.language || 'en',
        url: null, // Can be obtained from sites table if needed
        estimated_value: parseNumericValue(segmentData.estimatedValue) || 0,
        command_id: analysisCommandUuid,
        analysis: [] as any[],
        topics: [],
        icp: null
      };
      
      // Build analysis array with all segment data
      const analysisData: any[] = [];
      
      // Add audience profile with complete ad platforms structure to analysis
      if (segmentData.audienceProfile?.adPlatforms) {
        analysisData.push({ 
          type: 'audienceProfile', 
          data: segmentData.audienceProfile 
        });
        
        // Extract and add keywords from all platforms
        const allInterests = new Set<string>();
        
        // Google Ads interests
        if (segmentData.audienceProfile.adPlatforms.googleAds?.interests) {
          const googleInterests = Array.isArray(segmentData.audienceProfile.adPlatforms.googleAds.interests) 
            ? segmentData.audienceProfile.adPlatforms.googleAds.interests 
            : [segmentData.audienceProfile.adPlatforms.googleAds.interests];
          googleInterests.forEach((interest: string) => allInterests.add(interest));
        }
        
        // Facebook Ads interests
        if (segmentData.audienceProfile.adPlatforms.facebookAds?.interests) {
          const facebookInterests = Array.isArray(segmentData.audienceProfile.adPlatforms.facebookAds.interests) 
            ? segmentData.audienceProfile.adPlatforms.facebookAds.interests 
            : [segmentData.audienceProfile.adPlatforms.facebookAds.interests];
          facebookInterests.forEach((interest: string) => allInterests.add(interest));
        }
        
        // LinkedIn Ads interests (from industries)
        if (segmentData.audienceProfile.adPlatforms.linkedInAds?.industries) {
          const linkedInIndustries = Array.isArray(segmentData.audienceProfile.adPlatforms.linkedInAds.industries) 
            ? segmentData.audienceProfile.adPlatforms.linkedInAds.industries 
            : [segmentData.audienceProfile.adPlatforms.linkedInAds.industries];
          linkedInIndustries.forEach((industry: string) => allInterests.add(industry));
        }
        
        // Add all unique interests as keywords
        Array.from(allInterests).forEach((interest: string) => {
          analysisData.push({
            type: 'keyword',
            data: interest
          });
        });
      }
      
      // Add attributes to analysis if present
      if (segmentData.attributes) {
        analysisData.push({ 
          type: 'attributes', 
          data: segmentData.attributes 
        });
      }
      
      // Add monetization opportunities and recommended actions to analysis
      if (segmentData.monetizationOpportunities || segmentData.recommendedActions) {
        const additionalAnalysis: any = {};
        
        if (segmentData.monetizationOpportunities) {
          additionalAnalysis.monetizationOpportunities = segmentData.monetizationOpportunities;
        }
        
        if (segmentData.recommendedActions) {
          additionalAnalysis.recommendedActions = segmentData.recommendedActions;
        }
        
        analysisData.push({ 
          type: 'marketingInsights', 
          data: additionalAnalysis 
        });
      }
      
      // Set the analysis data
      dbSegmentData.analysis = analysisData;
      
      console.log(`📝 Guardando segmento: ${segmentData.name}`);
      console.log(`🔑 Command ID asignado: ${analysisCommandUuid}`);
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
          summary: segmentData.summary || '',
          estimatedSize: createdSegment.size?.toString() || '0',
          estimatedValue: createdSegment.estimated_value?.toString() || '0',
          profitabilityScore: segmentData.profitabilityScore || 0,
          confidenceScore: segmentData.confidenceScore || 0,
          targetAudience: createdSegment.audience,
          language: createdSegment.language,
          attributes: segmentData.attributes || {},
          audienceProfile: segmentData.audienceProfile || {},
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
  
  console.log(`🔄 INICIO: updateSegmentsWithIcpResults ejecutándose...`);
  console.log(`🔑 ICP Command UUID: ${icpCommandUuid}`);
  console.log(`📝 Segmentos existentes a actualizar: ${existingSegments.length}`);
  console.log(`📊 Resultados ICP recibidos: ${icpAnalysisResults ? icpAnalysisResults.length : 'NULL'}`);
  
  // LOG DETALLADO: Debug completo de parámetros de entrada
  console.log(`🔍 DEBUG ENTRADA - Type of icpAnalysisResults:`, typeof icpAnalysisResults);
  console.log(`🔍 DEBUG ENTRADA - icpAnalysisResults is array:`, Array.isArray(icpAnalysisResults));
  console.log(`🔍 DEBUG ENTRADA - icpAnalysisResults length:`, icpAnalysisResults?.length);
  console.log(`🔍 DEBUG ENTRADA - existingSegments length:`, existingSegments?.length);
  console.log(`🔍 DEBUG ENTRADA - existingSegments IDs:`, existingSegments?.map(s => s.id));
  
  if (!icpAnalysisResults) {
    console.log(`❌ ERROR: icpAnalysisResults es null o undefined`);
    return [];
  }
  
  if (!Array.isArray(icpAnalysisResults)) {
    console.log(`❌ ERROR: icpAnalysisResults no es un array:`, typeof icpAnalysisResults);
    console.log(`🔍 DEBUG ERROR: Contenido de icpAnalysisResults:`, icpAnalysisResults);
    return [];
  }
  
  if (icpAnalysisResults.length === 0) {
    console.log(`❌ ERROR: icpAnalysisResults está vacío`);
    return [];
  }
  
  console.log(`✅ VALIDACIÓN PASADA: Procesando ${icpAnalysisResults.length} resultados ICP`);
  
  // LOG MÁS DETALLADO de cada elemento
  icpAnalysisResults.forEach((item, index) => {
    console.log(`🔍 DEBUG ITEM[${index}]:`, {
      type: typeof item,
      isObject: typeof item === 'object',
      isNull: item === null,
      keys: item ? Object.keys(item) : 'N/A',
      hasSegmentId: !!(item?.segment_id),
      hasId: !!(item?.id),
      hasProfile: !!(item?.profile),
      profileId: item?.profile?.id
    });
  });
  
  console.log(`🔍 DEBUG: Primer resultado ICP completo:`, JSON.stringify(icpAnalysisResults[0], null, 2));
  
  let processedCount = 0;
  
  for (const icpData of icpAnalysisResults) {
    processedCount++;
    console.log(`🔍 DEBUG LOOP[${processedCount}]: Iniciando procesamiento de icpData`);
    console.log(`🔍 DEBUG LOOP[${processedCount}]: Tipo de icpData:`, typeof icpData);
    console.log(`🔍 DEBUG LOOP[${processedCount}]: Keys de icpData:`, icpData ? Object.keys(icpData) : 'null');
    
    try {
      // Try different possible ways to get segment_id
      let segmentId = icpData.segment_id || icpData.id || icpData.segmentId;
      
      // If still no segmentId found, check if it's nested in profile or other objects
      if (!segmentId && icpData.profile && icpData.profile.id) {
        // Extract segment ID from profile.id if it contains the original segment ID
        const profileId = icpData.profile.id;
        if (profileId.startsWith('icp_')) {
          // Extract the original segment ID from the profile ID format: icp_{segment_id}_{random}
          const parts = profileId.split('_');
          if (parts.length >= 3) {
            segmentId = parts.slice(1, -1).join('_'); // Get everything between 'icp_' and the last random part
          }
        }
      }
      
      if (!segmentId || !isValidUUID(segmentId)) {
        console.log(`⚠️ Segment ID inválido en análisis ICP: ${segmentId}`);
        console.log(`🔍 DEBUG: Estructura completa del icpData:`, Object.keys(icpData));
        console.log(`🔍 DEBUG: Intentando extraer ID de profile:`, icpData.profile?.id);
        continue;
      }
      
      // Find the existing segment
      const existingSegment = existingSegments.find(s => s.id === segmentId);
      if (!existingSegment) {
        console.log(`⚠️ Segmento no encontrado para ID: ${segmentId}`);
        continue;
      }
      
      console.log(`📝 Actualizando segmento: ${existingSegment.name}`);
      console.log(`🔑 Command ID original MANTENIDO: ${existingSegment.command_id || 'No definido'}`);
      console.log(`🆕 ICP Command UUID (solo para análisis): ${icpCommandUuid}`);
      
      // Prepare enhanced analysis data
      const currentAnalysis = Array.isArray(existingSegment.analysis) 
        ? existingSegment.analysis 
        : [];
      
      // Add ICP profile to the analysis and as a dedicated field
      const icpProfile = icpData.profile || icpData.icp || icpData.icpProfile || icpData;
      
      console.log(`🔍 DEBUG: ICP Profile extraído:`, JSON.stringify(icpProfile, null, 2));
      
      // Structure ICP data correctly with profile wrapper
      const icpStructuredData = {
        profile: icpProfile
      };
      
      const icpEnhancement = {
        type: 'icpAnalysis',
        data: icpProfile,
        timestamp: new Date().toISOString(),
        command_uuid: icpCommandUuid
      };
      
      const updatedAnalysis = [...currentAnalysis, icpEnhancement];
      
      const { data: updatedSegment, error: updateError } = await supabaseAdmin
        .from('segments')
        .update({ 
          analysis: updatedAnalysis,
          icp: icpStructuredData, // Store the ICP data with profile wrapper
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
          summary: '', // Summary not stored in DB
          estimatedSize: updatedSegment.size?.toString() || '0',
          estimatedValue: updatedSegment.estimated_value?.toString() || '0',
          profitabilityScore: 0, // Not stored in DB
          confidenceScore: 0, // Not stored in DB
          targetAudience: updatedSegment.audience,
          language: updatedSegment.language,
          attributes: {}, // Extracted from analysis
          audienceProfile: {}, // Extracted from analysis
          analysis: updatedSegment.analysis,
          icp: updatedSegment.icp, // Include the complete ICP structured data with profile wrapper
          icpEnhanced: true,
          icpProfile: icpProfile, // Also include the profile directly for compatibility
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