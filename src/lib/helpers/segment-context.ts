import { supabaseAdmin } from '@/lib/database/supabase-client';

export interface SegmentSummary {
  id: string;
  name: string;
  description: string | null;
  size: number | null;
  engagement: number | null;
  audience: string | null;
  relevantAnalysis: {
    audienceProfile?: any;
    attributes?: any;
    marketingInsights?: any;
    icpAnalysis?: any;
  };
}

/**
 * Obtiene un resumen de los segmentos activos de un sitio para ser usado en el contexto de campañas
 * @param siteId - ID del sitio
 * @returns Array de resúmenes de segmentos con información relevante para marketing
 */
export async function getSegmentsSummaryForCampaigns(siteId: string): Promise<SegmentSummary[]> {
  try {
    // Obtener segmentos activos del sitio
    const { data: segments, error } = await supabaseAdmin
      .from('segments')
      .select('id, name, description, size, engagement, audience, analysis')
      .eq('site_id', siteId)
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error al obtener segmentos:', error);
      return [];
    }

    if (!segments || segments.length === 0) {
      console.log(`No se encontraron segmentos activos para el sitio ${siteId}`);
      return [];
    }

    console.log(`📊 Encontrados ${segments.length} segmentos activos para el sitio ${siteId}`);

    // Procesar cada segmento para extraer análisis relevante
    const segmentSummaries: SegmentSummary[] = segments.map(segment => {
      const relevantAnalysis: any = {};

      // Procesar el campo analysis si existe
      if (segment.analysis && Array.isArray(segment.analysis)) {
        segment.analysis.forEach((analysisItem: any) => {
          if (analysisItem.type && analysisItem.data) {
            switch (analysisItem.type) {
              case 'audienceProfile':
                relevantAnalysis.audienceProfile = extractAudienceProfileSummary(analysisItem.data);
                break;
              case 'attributes':
                relevantAnalysis.attributes = analysisItem.data;
                break;
              case 'marketingInsights':
                relevantAnalysis.marketingInsights = extractMarketingInsights(analysisItem.data);
                break;
              case 'icpAnalysis':
                relevantAnalysis.icpAnalysis = extractIcpSummary(analysisItem.data);
                break;
            }
          }
        });
      }

      return {
        id: segment.id,
        name: segment.name,
        description: segment.description,
        size: segment.size,
        engagement: segment.engagement,
        audience: segment.audience,
        relevantAnalysis
      };
    });

    return segmentSummaries;
  } catch (error) {
    console.error('Error en getSegmentsSummaryForCampaigns:', error);
    return [];
  }
}

/**
 * Extrae información relevante del perfil de audiencia
 */
function extractAudienceProfileSummary(audienceProfile: any): any {
  if (!audienceProfile) return null;

  return {
    demographics: audienceProfile.demographics || null,
    interests: extractInterestsFromAdPlatforms(audienceProfile.adPlatforms),
    behaviors: audienceProfile.behaviors || null,
    platforms: Object.keys(audienceProfile.adPlatforms || {})
  };
}

/**
 * Extrae intereses de las diferentes plataformas de ads
 */
function extractInterestsFromAdPlatforms(adPlatforms: any): string[] {
  if (!adPlatforms) return [];

  const interests: string[] = [];

  // Google Ads
  if (adPlatforms.googleAds?.interests) {
    const googleInterests = Array.isArray(adPlatforms.googleAds.interests) 
      ? adPlatforms.googleAds.interests 
      : [adPlatforms.googleAds.interests];
    interests.push(...googleInterests);
  }

  // Facebook Ads
  if (adPlatforms.facebookAds?.interests) {
    const facebookInterests = Array.isArray(adPlatforms.facebookAds.interests) 
      ? adPlatforms.facebookAds.interests 
      : [adPlatforms.facebookAds.interests];
    interests.push(...facebookInterests);
  }

  // LinkedIn Ads
  if (adPlatforms.linkedInAds?.industries) {
    const linkedInIndustries = Array.isArray(adPlatforms.linkedInAds.industries) 
      ? adPlatforms.linkedInAds.industries 
      : [adPlatforms.linkedInAds.industries];
    interests.push(...linkedInIndustries);
  }

  // Remover duplicados y retornar solo los primeros 10 más relevantes
  return Array.from(new Set(interests)).slice(0, 10);
}

/**
 * Extrae insights de marketing relevantes
 */
function extractMarketingInsights(marketingData: any): any {
  if (!marketingData) return null;

  return {
    monetizationOpportunities: marketingData.monetizationOpportunities || null,
    recommendedActions: marketingData.recommendedActions || null
  };
}

/**
 * Extrae resumen del análisis ICP
 */
function extractIcpSummary(icpData: any): any {
  if (!icpData || !icpData.profile) return null;

  const profile = icpData.profile;
  
  return {
    demographics: {
      ageRange: profile.demographics?.ageRange || null,
      income: profile.demographics?.income || null,
      education: profile.demographics?.education || null
    },
    psychographics: {
      painPoints: profile.psychographics?.painPoints || [],
      motivations: profile.psychographics?.motivations || [],
      values: profile.psychographics?.values || []
    },
    behaviorPatterns: profile.behaviorPatterns || null,
    preferredChannels: profile.preferredChannels || []
  };
}

/**
 * Genera un contexto de texto formateado con la información de segmentos
 */
export function formatSegmentsContextForCampaigns(segments: SegmentSummary[]): string {
  if (!segments || segments.length === 0) {
    return "No audience segments available for this site.";
  }

  let context = `AVAILABLE AUDIENCE SEGMENTS (${segments.length} total):\n\n`;

  segments.forEach((segment, index) => {
    context += `${index + 1}. **${segment.name}**\n`;
    
    if (segment.description) {
      context += `   Description: ${segment.description}\n`;
    }
    
    if (segment.size) {
      context += `   Estimated Size: ${segment.size.toLocaleString()} users\n`;
    }
    
    if (segment.audience) {
      context += `   Target Audience: ${segment.audience}\n`;
    }

    // Añadir información relevante del análisis
    const analysis = segment.relevantAnalysis;
    
    if (analysis.audienceProfile?.interests && analysis.audienceProfile.interests.length > 0) {
      context += `   Key Interests: ${analysis.audienceProfile.interests.slice(0, 5).join(', ')}\n`;
    }

    if (analysis.icpAnalysis?.psychographics?.painPoints && analysis.icpAnalysis.psychographics.painPoints.length > 0) {
      context += `   Main Pain Points: ${analysis.icpAnalysis.psychographics.painPoints.slice(0, 3).join(', ')}\n`;
    }

    if (analysis.icpAnalysis?.preferredChannels && analysis.icpAnalysis.preferredChannels.length > 0) {
      context += `   Preferred Channels: ${analysis.icpAnalysis.preferredChannels.slice(0, 3).join(', ')}\n`;
    }

    if (analysis.marketingInsights?.monetizationOpportunities) {
      context += `   Monetization Opportunities: Available\n`;
    }

    context += '\n';
  });

  context += `\nKEY CONSIDERATIONS:\n`;
  context += `- Consider creating segment-specific campaigns to maximize relevance\n`;
  context += `- Leverage the identified pain points and interests for better targeting\n`;
  context += `- Use preferred channels information for optimal campaign distribution\n`;
  context += `- Consider cross-segment opportunities where interests overlap\n`;

  return context;
} 