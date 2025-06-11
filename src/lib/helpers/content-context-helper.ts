import { supabaseAdmin } from '@/lib/database/supabase-client';

// Function to validate UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Interface for segment information
interface SegmentInfo {
  id: string;
  name: string;
  description: string;
  criteria: string;
  audience_criteria: string;
  audience_size: string | number;
  size: string | number;
  interests: string[];
  pain_points: string[];
  behaviors?: string;
  content_preferences?: string;
  demographics?: any;
  metadata?: any;
}

// Interface for campaign information
interface CampaignInfo {
  id: string;
  name: string;
  title: string;
  description: string;
  goal: string;
  objective: string;
  start_date: string;
  end_date: string;
  target_audience: string;
  channels: string[];
  kpis: string[];
  budget?: string;
  messaging?: string;
  content_requirements?: string;
  status: string;
  priority?: string;
  metadata?: any;
}

// Function to get segment information from database
export async function getSegmentInfo(segmentId: string): Promise<SegmentInfo | null> {
  try {
    if (!segmentId || !isValidUUID(segmentId)) {
      console.log(`❌ Invalid segment ID: ${segmentId}`);
      return null;
    }
    
    console.log(`🔍 [getSegmentInfo] Obteniendo información del segmento: ${segmentId}`);
    
    const { data, error } = await supabaseAdmin
      .from('segments')
      .select('*')
      .eq('id', segmentId)
      .single();
    
    if (error) {
      console.error(`❌ Error fetching segment info: ${error.message}`);
      return null;
    }
    
    if (!data) {
      console.log(`⚠️ No se encontró información del segmento: ${segmentId}`);
      return null;
    }
    
    console.log(`✅ Información del segmento recuperada: ${data.name || 'Sin nombre'}`);
    return data;
  } catch (error) {
    console.error('❌ Error getting segment info:', error);
    return null;
  }
}

// Function to get campaign information from database
export async function getCampaignInfo(campaignId: string): Promise<CampaignInfo | null> {
  try {
    if (!campaignId || !isValidUUID(campaignId)) {
      console.log(`❌ Invalid campaign ID: ${campaignId}`);
      return null;
    }
    
    console.log(`🔍 [getCampaignInfo] Obteniendo información de la campaña: ${campaignId}`);
    
    const { data, error } = await supabaseAdmin
      .from('campaigns')
      .select('*')
      .eq('id', campaignId)
      .single();
    
    if (error) {
      console.error(`❌ Error fetching campaign info: ${error.message}`);
      return null;
    }
    
    if (!data) {
      console.log(`⚠️ No se encontró información de la campaña: ${campaignId}`);
      return null;
    }
    
    console.log(`✅ Información de la campaña recuperada: ${data.name || data.title || 'Sin nombre'}`);
    return data;
  } catch (error) {
    console.error('❌ Error getting campaign info:', error);
    return null;
  }
}

// Function to format segment info as context string
export function formatSegmentContext(segmentInfo: SegmentInfo): string {
  const segmentData = {
    name: segmentInfo.name || 'Unnamed Segment',
    description: segmentInfo.description || 'No description available',
    audience_criteria: segmentInfo.criteria || segmentInfo.audience_criteria || 'N/A',
    size: segmentInfo.size || segmentInfo.audience_size || 'Unknown',
    interests: Array.isArray(segmentInfo.interests) ? segmentInfo.interests : [],
    pain_points: Array.isArray(segmentInfo.pain_points) ? segmentInfo.pain_points : []
  };
  
  let context = `AUDIENCE SEGMENT INFORMATION:
- Name: ${segmentData.name}
- Description: ${segmentData.description}
- Target Criteria: ${segmentData.audience_criteria}
- Segment Size: ${segmentData.size}`;

  if (segmentData.interests.length > 0) {
    context += `\n- Key Interests: ${segmentData.interests.join(', ')}`;
  }
  
  if (segmentData.pain_points.length > 0) {
    context += `\n- Pain Points: ${segmentData.pain_points.join(', ')}`;
  }
  
  if (segmentInfo.behaviors) {
    context += `\n- Key Behaviors: ${segmentInfo.behaviors}`;
  }
  
  if (segmentInfo.content_preferences) {
    context += `\n- Content Preferences: ${segmentInfo.content_preferences}`;
  }
  
  if (segmentInfo.demographics) {
    context += `\n- Demographics: ${typeof segmentInfo.demographics === 'string' ? segmentInfo.demographics : JSON.stringify(segmentInfo.demographics)}`;
  }
  
  return context;
}

// Function to format campaign info as context string
export function formatCampaignContext(campaignInfo: CampaignInfo): string {
  const campaignData = {
    name: campaignInfo.name || campaignInfo.title || 'Unnamed Campaign',
    description: campaignInfo.description || 'No description available',
    goal: campaignInfo.goal || campaignInfo.objective || 'N/A',
    start_date: campaignInfo.start_date || 'N/A',
    end_date: campaignInfo.end_date || 'N/A',
    target_audience: campaignInfo.target_audience || 'N/A',
    channels: Array.isArray(campaignInfo.channels) ? campaignInfo.channels : [],
    kpis: Array.isArray(campaignInfo.kpis) ? campaignInfo.kpis : [],
    status: campaignInfo.status || 'Unknown'
  };
  
  let context = `CAMPAIGN INFORMATION:
- Name: ${campaignData.name}
- Description: ${campaignData.description}
- Primary Goal: ${campaignData.goal}
- Status: ${campaignData.status}
- Timeline: ${campaignData.start_date} to ${campaignData.end_date}
- Target Audience: ${campaignData.target_audience}`;

  if (campaignData.channels.length > 0) {
    context += `\n- Distribution Channels: ${campaignData.channels.join(', ')}`;
  }
  
  if (campaignData.kpis.length > 0) {
    context += `\n- Key Performance Indicators: ${campaignData.kpis.join(', ')}`;
  }
  
  if (campaignInfo.budget) {
    context += `\n- Budget: ${campaignInfo.budget}`;
  }
  
  if (campaignInfo.messaging) {
    context += `\n- Key Messaging: ${campaignInfo.messaging}`;
  }
  
  if (campaignInfo.content_requirements) {
    context += `\n- Content Requirements: ${campaignInfo.content_requirements}`;
  }
  
  if (campaignInfo.priority) {
    context += `\n- Priority: ${campaignInfo.priority}`;
  }
  
  return context;
}

// Main function to build context from segment and campaign information
export async function buildContentEditingContext(segmentId?: string, campaignId?: string): Promise<string> {
  console.log(`🔍 [buildContentEditingContext] Construyendo contexto para segmento: ${segmentId || 'N/A'}, campaña: ${campaignId || 'N/A'}`);
  
  const contextParts: string[] = [];
  
  // Get segment information if available
  if (segmentId) {
    const segmentInfo = await getSegmentInfo(segmentId);
    if (segmentInfo) {
      const segmentContext = formatSegmentContext(segmentInfo);
      contextParts.push(segmentContext);
      console.log(`✅ [buildContentEditingContext] Contexto de segmento agregado`);
    } else {
      contextParts.push(`AUDIENCE SEGMENT INFORMATION:\n- Segment ID: ${segmentId}\n- Note: No additional segment information available`);
      console.log(`⚠️ [buildContentEditingContext] No se pudo obtener información del segmento`);
    }
  }
  
  // Get campaign information if available
  if (campaignId) {
    const campaignInfo = await getCampaignInfo(campaignId);
    if (campaignInfo) {
      const campaignContext = formatCampaignContext(campaignInfo);
      contextParts.push(campaignContext);
      console.log(`✅ [buildContentEditingContext] Contexto de campaña agregado`);
    } else {
      contextParts.push(`CAMPAIGN INFORMATION:\n- Campaign ID: ${campaignId}\n- Note: No additional campaign information available`);
      console.log(`⚠️ [buildContentEditingContext] No se pudo obtener información de la campaña`);
    }
  }
  
  const finalContext = contextParts.join('\n\n');
  console.log(`📝 [buildContentEditingContext] Contexto final generado con ${contextParts.length} secciones (${finalContext.length} caracteres)`);
  
  return finalContext;
}

// Function to get context summary for logging purposes
export function getContextSummary(segmentId?: string, campaignId?: string): string {
  const parts = [];
  if (segmentId) parts.push(`Segment: ${segmentId.substring(0, 8)}...`);
  if (campaignId) parts.push(`Campaign: ${campaignId.substring(0, 8)}...`);
  return parts.length > 0 ? parts.join(', ') : 'No context';
} 