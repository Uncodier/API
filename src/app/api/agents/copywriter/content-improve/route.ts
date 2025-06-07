import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { getCommandById as dbGetCommandById } from '@/lib/database/command-db';
import { DatabaseAdapter } from '@/lib/agentbase/adapters/DatabaseAdapter';
import { supabaseAdmin } from '@/lib/database/supabase-client';

// Function to validate UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Function to find copywriter agent for a site
async function findCopywriterAgent(siteId: string): Promise<{agentId: string, userId: string} | null> {
  try {
    if (!siteId || !isValidUUID(siteId)) {
      console.error(`❌ Invalid site_id for copywriter agent search: ${siteId}`);
      return null;
    }
    
    console.log(`🔍 Buscando agente con rol "copywriter" para el sitio: ${siteId}`);
    
    // Buscar un agente activo con el rol adecuado
    const { data, error } = await supabaseAdmin
      .from('agents')
      .select('id, user_id')
      .eq('site_id', siteId)
      .eq('status', 'active')
      .eq('role', 'Content Creator & Copywriter')
      .order('created_at', { ascending: false })
      .limit(1);
    
    if (error) {
      console.error('Error al buscar agente con rol "copywriter":', error);
      return null;
    }
    
    if (!data || data.length === 0) {
      console.log(`⚠️ No se encontró ningún agente con rol "copywriter" activo para el sitio: ${siteId}`);
      return null;
    }
    
    console.log(`✅ Agente con rol "copywriter" encontrado: ${data[0].id} (user_id: ${data[0].user_id})`);
    return {
      agentId: data[0].id,
      userId: data[0].user_id
    };
  } catch (error) {
    console.error('Error al buscar agente copywriter:', error);
    return null;
  }
}

// Function to get agent information
async function getAgentInfo(agentId: string): Promise<{ user_id: string; site_id?: string; tools?: any[] } | null> {
  try {
    if (!isValidUUID(agentId)) {
      console.error(`❌ Invalid agentId: ${agentId}`);
      return null;
    }
    
    console.log(`🔍 Obteniendo información del agente: ${agentId}`);
    
    const { data, error } = await supabaseAdmin
      .from('agents')
      .select('user_id, site_id, tools')
      .eq('id', agentId)
      .single();
    
    if (error) {
      console.error('Error al obtener información del agente:', error);
      return null;
    }
    
    if (!data) {
      console.log(`⚠️ No se encontró agente con ID: ${agentId}`);
      return null;
    }
    
    console.log(`✅ Información del agente obtenida: user_id=${data.user_id}, site_id=${data.site_id}`);
    return data;
  } catch (error) {
    console.error('Error al obtener información del agente:', error);
    return null;
  }
}

// Function to get content from database by ID
async function getContentById(contentId: string): Promise<any | null> {
  try {
    if (!isValidUUID(contentId)) {
      console.log(`Invalid content ID: ${contentId}`);
      return null;
    }
    
    const { data, error } = await supabaseAdmin
      .from('content')
      .select('*')
      .eq('id', contentId)
      .single();
    
    if (error) {
      console.error(`Error fetching content: ${error.message}`);
      return null;
    }
    
    return data;
  } catch (error) {
    console.error('Error getting content by ID:', error);
    return null;
  }
}

// Function to get draft content for a site
async function getDraftContentForSite(
  siteId: string,
  segmentId?: string,
  campaignId?: string,
  contentIds?: string[],
  limit: number = 50
): Promise<any[]> {
  try {
    if (!isValidUUID(siteId)) {
      console.log(`Invalid site ID: ${siteId}`);
      return [];
    }
    
    let query = supabaseAdmin
      .from('content')
      .select('*')
      .eq('site_id', siteId)
      .eq('status', 'draft')
      .order('created_at', { ascending: false })
      .limit(limit);
    
    // Add optional filters
    if (segmentId && isValidUUID(segmentId)) {
      query = query.eq('segment_id', segmentId);
    }
    
    if (campaignId && isValidUUID(campaignId)) {
      query = query.eq('campaign_id', campaignId);
    }
    
    // Filter by specific content IDs if provided
    if (contentIds && contentIds.length > 0) {
      const validContentIds = contentIds.filter(id => isValidUUID(id));
      if (validContentIds.length > 0) {
        query = query.in('id', validContentIds);
      }
    }
    
    const { data, error } = await query;
    
    if (error) {
      console.error(`Error fetching draft content: ${error.message}`);
      return [];
    }
    
    return data || [];
  } catch (error) {
    console.error('Error getting draft content:', error);
    return [];
  }
}

// Function to update multiple content items in the database
async function updateMultipleContentInDatabase(
  improvementResults: Array<{contentId: string, improvedContent: any}>,
  userId?: string
): Promise<{updated: any[], failed: string[]}> {
  const updated = [];
  const failed = [];
  
  for (const result of improvementResults) {
    try {
      const { contentId, improvedContent } = result;
      
      if (!isValidUUID(contentId)) {
        console.log(`Invalid content ID: ${contentId}`);
        failed.push(contentId);
        continue;
      }
      
      // Prepare update data
      const updateData = {
        title: improvedContent.title || undefined,
        description: improvedContent.description || undefined,
        text: improvedContent.text || improvedContent.content || undefined,
        status: 'draft',
        updated_at: new Date().toISOString(),
        metadata: {
          ...improvedContent.metadata,
          improved_at: new Date().toISOString(),
          improved_by: userId || 'system',
          improvement_notes: improvedContent.improvement_notes || null,
          original_score: improvedContent.original_score || null,
          improved_score: improvedContent.improved_score || null,
          improvements_applied: improvedContent.improvements_applied || []
        }
      };
      
      // Remove undefined values
      Object.keys(updateData).forEach(key => {
        if ((updateData as any)[key] === undefined) {
          delete (updateData as any)[key];
        }
      });
      
      console.log(`Updating content ${contentId} with improved version:`);
      console.log(`  - Title: ${improvedContent.title ? improvedContent.title.substring(0, 50) + '...' : 'No title'}`);
      console.log(`  - Description: ${improvedContent.description ? improvedContent.description.substring(0, 50) + '...' : 'No description'}`);
      console.log(`  - Text length: ${improvedContent.text ? improvedContent.text.length : 0} characters`);
      
      const { data, error } = await supabaseAdmin
        .from('content')
        .update(updateData)
        .eq('id', contentId)
        .select()
        .single();
      
      if (error) {
        console.error(`Error updating content ${contentId}:`, error);
        failed.push(contentId);
      } else {
        console.log(`Successfully updated content ${contentId}`);
        updated.push(data);
      }
    } catch (error: any) {
      console.error(`Error updating content ${result.contentId}:`, error);
      failed.push(result.contentId);
    }
  }
  
  return { updated, failed };
}

// Initialize agent and get command service
const processorInitializer = ProcessorInitializer.getInstance();
processorInitializer.initialize();
const commandService = processorInitializer.getCommandService();

// Function to get the DB UUID for a command
async function getCommandDbUuid(internalId: string): Promise<string | null> {
  try {
    const command = await commandService.getCommandById(internalId);
    
    if (command && command.metadata && command.metadata.dbUuid) {
      if (isValidUUID(command.metadata.dbUuid)) {
        console.log(`🔑 UUID found in metadata: ${command.metadata.dbUuid}`);
        return command.metadata.dbUuid;
      }
    }
    
    try {
      // @ts-ignore - Accessing internal properties
      const idMap = (commandService as any).idTranslationMap;
      if (idMap && idMap.get && idMap.get(internalId)) {
        const mappedId = idMap.get(internalId);
        if (isValidUUID(mappedId)) {
          console.log(`🔑 UUID found in internal map: ${mappedId}`);
          return mappedId;
        }
      }
    } catch (err) {
      console.log('Could not access internal translation map');
    }
    
    if (command) {
      const { data, error } = await supabaseAdmin
        .from('commands')
        .select('id')
        .eq('task', command.task)
        .eq('user_id', command.user_id)
        .eq('status', command.status)
        .order('created_at', { ascending: false })
        .limit(1);
      
      if (!error && data && data.length > 0) {
        console.log(`🔑 UUID found in direct search: ${data[0].id}`);
        return data[0].id;
      }
    }
    
    return null;
  } catch (error) {
    console.error('Error getting database UUID:', error);
    return null;
  }
}

// Function to wait for command completion
async function waitForCommandCompletion(commandId: string, maxAttempts = 120, delayMs = 1000) {
  let executedCommand = null;
  let attempts = 0;
  let dbUuid: string | null = null;
  
  console.log(`⏳ Waiting for command ${commandId} to complete...`);
  
  return new Promise<{command: any, dbUuid: string | null, completed: boolean}>((resolve) => {
    const checkInterval = setInterval(async () => {
      attempts++;
      
      try {
        executedCommand = await commandService.getCommandById(commandId);
        
        if (!executedCommand) {
          console.log(`⚠️ Could not find command ${commandId}`);
          clearInterval(checkInterval);
          resolve({command: null, dbUuid: null, completed: false});
          return;
        }
        
        if (executedCommand.metadata && executedCommand.metadata.dbUuid) {
          dbUuid = executedCommand.metadata.dbUuid as string;
          console.log(`🔑 Database UUID found in metadata: ${dbUuid}`);
        }
        
        if (executedCommand.status === 'completed' || executedCommand.status === 'failed') {
          console.log(`✅ Command ${commandId} completed with status: ${executedCommand.status}`);
          
          if (!dbUuid || !isValidUUID(dbUuid)) {
            dbUuid = await getCommandDbUuid(commandId);
            console.log(`🔍 UUID obtained after completion: ${dbUuid || 'Not found'}`);
          }
          
          clearInterval(checkInterval);
          resolve({command: executedCommand, dbUuid, completed: executedCommand.status === 'completed'});
          return;
        }
        
        console.log(`⏳ Command ${commandId} still running (status: ${executedCommand.status}), attempt ${attempts}/${maxAttempts}`);
        
        if (attempts >= maxAttempts) {
          console.log(`⏰ Timeout for command ${commandId}`);
          
          if (!dbUuid || !isValidUUID(dbUuid)) {
            dbUuid = await getCommandDbUuid(commandId);
            console.log(`🔍 UUID obtained before timeout: ${dbUuid || 'Not found'}`);
          }
          
          clearInterval(checkInterval);
          resolve({command: executedCommand, dbUuid, completed: false});
        }
      } catch (error) {
        console.error(`Error checking command status ${commandId}:`, error);
        clearInterval(checkInterval);
        resolve({command: null, dbUuid: null, completed: false});
      }
    }, delayMs);
  });
}

// Function to get segment information from database
async function getSegmentInfo(segmentId: string): Promise<any | null> {
  try {
    if (!isValidUUID(segmentId)) {
      console.log(`Invalid segment ID: ${segmentId}`);
      return null;
    }
    
    const { data, error } = await supabaseAdmin
      .from('segments')
      .select('*')
      .eq('id', segmentId)
      .single();
    
    if (error) {
      console.error(`Error fetching segment info: ${error.message}`);
      return null;
    }
    
    return data;
  } catch (error) {
    console.error('Error getting segment info:', error);
    return null;
  }
}

// Function to get campaign information from database
async function getCampaignInfo(campaignId: string): Promise<any | null> {
  try {
    if (!isValidUUID(campaignId)) {
      console.log(`Invalid campaign ID: ${campaignId}`);
      return null;
    }
    
    const { data, error } = await supabaseAdmin
      .from('campaigns')
      .select('*')
      .eq('id', campaignId)
      .single();
    
    if (error) {
      console.error(`Error fetching campaign info: ${error.message}`);
      return null;
    }
    
    return data;
  } catch (error) {
    console.error('Error getting campaign info:', error);
    return null;
  }
}

// Function to get site information from database
async function getSiteInfo(siteId: string): Promise<any | null> {
  try {
    if (!isValidUUID(siteId)) {
      console.log(`Invalid site ID: ${siteId}`);
      return null;
    }
    
    const { data, error } = await supabaseAdmin
      .from('sites')
      .select('*')
      .eq('id', siteId)
      .single();
    
    if (error) {
      console.error(`Error fetching site info: ${error.message}`);
      return null;
    }
    
    return data;
  } catch (error) {
    console.error('Error getting site info:', error);
    return null;
  }
}

// Build context from available information
async function buildContext(
  siteId: string, 
  draftContent: any[],
  segmentId?: string, 
  campaignId?: string
): Promise<string> {
  let contextParts = [];
  
  // Add content information
  if (draftContent && draftContent.length > 0) {
    contextParts.push(`DRAFT CONTENT TO IMPROVE (${draftContent.length} items):
${draftContent.map((content, index) => `
${index + 1}. ID: ${content.id}
   - Title: ${content.title || 'No title'}
   - Description: ${content.description || 'No description'}
   - Content Type: ${content.type || 'Unknown'}
   - Created: ${content.created_at || 'Unknown'}
   - Content Length: ${content.text ? content.text.length : 0} characters
   - Preview: ${content.text ? content.text.substring(0, 150) + '...' : 'No content'}
`).join('')}

BULK IMPROVEMENT TASK:
Improve ALL the above content items simultaneously, maintaining consistency in style and quality across all pieces while optimizing each one individually for its specific purpose and context.`);
  }
  
  // Get site information
  const siteInfo = await getSiteInfo(siteId);
  if (siteInfo) {
    const siteData = {
      name: siteInfo.name || 'Unnamed Site',
      description: siteInfo.description || 'No description available',
      domain: siteInfo.domain || 'N/A',
      primary_industry: siteInfo.industry || siteInfo.primary_industry || 'N/A',
      language: siteInfo.language || 'en',
      created_at: siteInfo.created_at || 'N/A'
    };
    
    contextParts.push(`SITE INFORMATION:
- Name: ${siteData.name}
- Description: ${siteData.description}
- Domain: ${siteData.domain}
- Industry: ${siteData.primary_industry}
- Language: ${siteData.language}
- Created: ${siteData.created_at}
    
${siteInfo.business_description ? `Business Description: ${siteInfo.business_description}` : ''}
${siteInfo.audience_description ? `Target Audience: ${siteInfo.audience_description}` : ''}
${siteInfo.challenges ? `Main Challenges: ${siteInfo.challenges}` : ''}
${siteInfo.competitors ? `Competitors: ${siteInfo.competitors}` : ''}
${siteInfo.unique_selling_proposition ? `Unique Selling Proposition: ${siteInfo.unique_selling_proposition}` : ''}
${siteInfo.brand_voice ? `Brand Voice: ${siteInfo.brand_voice}` : ''}`);
  }
  
  // Get segment information if available
  if (segmentId) {
    const segmentInfo = await getSegmentInfo(segmentId);
    if (segmentInfo) {
      const segmentData = {
        name: segmentInfo.name || 'Unnamed Segment',
        description: segmentInfo.description || 'No description available',
        audience_criteria: segmentInfo.criteria || segmentInfo.audience_criteria || 'N/A',
        size: segmentInfo.size || segmentInfo.audience_size || 'Unknown',
        interests: segmentInfo.interests || [],
        pain_points: segmentInfo.pain_points || []
      };
      
      contextParts.push(`AUDIENCE SEGMENT INFORMATION:
- Name: ${segmentData.name}
- Description: ${segmentData.description}
- Criteria: ${segmentData.audience_criteria}
- Segment Size: ${segmentData.size}
${Array.isArray(segmentData.interests) && segmentData.interests.length > 0 ? `- Interests: ${segmentData.interests.join(', ')}` : ''}
${Array.isArray(segmentData.pain_points) && segmentData.pain_points.length > 0 ? `- Pain Points: ${segmentData.pain_points.join(', ')}` : ''}
${segmentInfo.behaviors ? `- Key Behaviors: ${segmentInfo.behaviors}` : ''}
${segmentInfo.content_preferences ? `- Content Preferences: ${segmentInfo.content_preferences}` : ''}`);
    }
  }
  
  // Get campaign information if available
  if (campaignId) {
    const campaignInfo = await getCampaignInfo(campaignId);
    if (campaignInfo) {
      const campaignData = {
        name: campaignInfo.name || 'Unnamed Campaign',
        description: campaignInfo.description || 'No description available',
        goal: campaignInfo.goal || campaignInfo.objective || 'N/A',
        start_date: campaignInfo.start_date || 'N/A',
        end_date: campaignInfo.end_date || 'N/A',
        target_audience: campaignInfo.target_audience || 'N/A',
        channels: campaignInfo.channels || [],
        kpis: campaignInfo.kpis || []
      };
      
      contextParts.push(`CAMPAIGN INFORMATION:
- Name: ${campaignData.name}
- Description: ${campaignData.description}
- Primary Goal: ${campaignData.goal}
- Timeline: ${campaignData.start_date} to ${campaignData.end_date}
- Target Audience: ${campaignData.target_audience}
${Array.isArray(campaignData.channels) && campaignData.channels.length > 0 ? `- Distribution Channels: ${campaignData.channels.join(', ')}` : ''}
${Array.isArray(campaignData.kpis) && campaignData.kpis.length > 0 ? `- Key Performance Indicators: ${campaignData.kpis.join(', ')}` : ''}
${campaignInfo.budget ? `- Budget: ${campaignInfo.budget}` : ''}
${campaignInfo.messaging ? `- Key Messaging: ${campaignInfo.messaging}` : ''}
${campaignInfo.content_requirements ? `- Content Requirements: ${campaignInfo.content_requirements}` : ''}`);
    }
  }
  
  return contextParts.join('\n\n');
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    
    // Extract parameters from the request
    const { 
      siteId, 
      contentIds, // Optional array of specific content IDs
      segmentId, 
      campaignId, 
      userId, 
      agent_id,
      improvementGoals,
      targetAudience,
      keywords,
      contentStyle,
      maxLength,
      limit
    } = body;
    
    // Validate required parameters
    if (!siteId) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'siteId is required' } },
        { status: 400 }
      );
    }
    
    if (!isValidUUID(siteId)) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'siteId must be a valid UUID' } },
        { status: 400 }
      );
    }
    
    // Validate contentIds if provided
    if (contentIds && (!Array.isArray(contentIds) || contentIds.some(id => !isValidUUID(id)))) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'contentIds must be an array of valid UUIDs' } },
        { status: 400 }
      );
    }
    
    // Determine the user ID from the request or agent
    let effectiveUserId = userId;
    let effectiveAgentId = agent_id;
    
    // Si no se proporciona agent_id, buscar uno para el sitio
    if (!effectiveAgentId) {
      const foundAgent = await findCopywriterAgent(siteId);
      if (foundAgent) {
        effectiveAgentId = foundAgent.agentId;
        if (!effectiveUserId) {
          effectiveUserId = foundAgent.userId;
        }
        console.log(`🤖 Usando agente con rol "copywriter" encontrado: ${effectiveAgentId} (user_id: ${effectiveUserId})`);
      } else {
        // Use default agent if no specific agent found
        effectiveAgentId = 'default_copywriter_agent';
        console.log(`🤖 No se encontró agente específico, usando agente por defecto: ${effectiveAgentId}`);
      }
    }
    
    // Si se proporciona agent_id, obtener su user_id si no tenemos uno
    if (effectiveAgentId && !effectiveUserId) {
      const agentInfo = await getAgentInfo(effectiveAgentId);
      
      if (!agentInfo) {
        return NextResponse.json(
          { success: false, error: { code: 'AGENT_NOT_FOUND', message: 'The specified agent was not found' } },
          { status: 404 }
        );
      }
      
      effectiveUserId = agentInfo.user_id;
    }
    
    // Validate we have a user ID one way or another
    if (!effectiveUserId) {
      effectiveUserId = 'system';
    }
    
    const effectiveLimit = limit || 50;
    
    console.log(`Creating bulk content improvement command for agent: ${effectiveAgentId}, user: ${effectiveUserId}, site: ${siteId}`);
    
    // Get draft content to improve
    const draftContent = await getDraftContentForSite(
      siteId, 
      segmentId, 
      campaignId, 
      contentIds,
      effectiveLimit
    );
    
    if (draftContent.length === 0) {
      return NextResponse.json(
        { success: false, error: { code: 'NO_DRAFT_CONTENT', message: 'No draft content found for improvement' } },
        { status: 404 }
      );
    }
    
    console.log(`Found ${draftContent.length} draft content items to improve`);
    
    // Build context with site, segment, campaign, and content information
    const context = await buildContext(siteId, draftContent, segmentId, campaignId);
    
    // Additional context from request parameters
    let additionalContext = [];

    if (improvementGoals && Array.isArray(improvementGoals) && improvementGoals.length > 0) {
      additionalContext.push(`IMPROVEMENT GOALS:`);
      improvementGoals.forEach((goal, index) => {
        additionalContext.push(`  ${index + 1}. ${goal}`);
      });
    }

    if (targetAudience) {
      const formattedAudience = Array.isArray(targetAudience) 
        ? targetAudience.join(', ') 
        : targetAudience;
      additionalContext.push(`TARGET AUDIENCE FOCUS: ${formattedAudience}`);
    }

    if (keywords && Array.isArray(keywords) && keywords.length > 0) {
      additionalContext.push(`KEYWORDS TO OPTIMIZE:`);
      const groupedKeywords = [];
      for (let i = 0; i < keywords.length; i += 5) {
        const group = keywords.slice(i, i + 5).join(', ');
        groupedKeywords.push(`  • ${group}`);
      }
      additionalContext.push(groupedKeywords.join('\n'));
    }

    if (contentStyle) {
      additionalContext.push(`CONTENT STYLE: ${contentStyle}`);
    }

    if (maxLength) {
      additionalContext.push(`MAXIMUM LENGTH PER CONTENT: ${maxLength} characters`);
    }
    
    const fullContext = additionalContext.length > 0 
      ? `Perform BULK IMPROVEMENT of all draft content for maximum business impact and consistency.

BULK IMPROVEMENT OBJECTIVES:
- Improve ALL content items simultaneously while maintaining consistency
- Enhance content quality, readability, and engagement across all pieces
- Optimize for SEO and target keywords while maintaining natural flow
- Align all content with brand voice and target audience preferences
- Improve structure, clarity, and call-to-action effectiveness
- Ensure all content meets current marketing goals and campaign objectives
- Maintain each content's original purpose while maximizing impact

BULK IMPROVEMENT GUIDELINES:
1. Content Analysis (for all items):
   - Assess current content strengths and weaknesses
   - Identify opportunities for SEO optimization
   - Evaluate alignment with target audience and brand voice
   - Check for clarity, flow, and engagement factors

2. Content Enhancement (for each item):
   - Improve headlines and subheadings for better impact
   - Enhance introductions and conclusions for stronger engagement
   - Optimize content structure and readability
   - Incorporate target keywords naturally
   - Strengthen call-to-action elements
   - Add relevant examples, statistics, or case studies if appropriate

3. Consistency Assurance:
   - Maintain consistent brand voice across all content
   - Ensure cohesive messaging and style
   - Apply uniform quality standards
   - Coordinate keyword usage across pieces

4. Deliverables (for each content item):
   - Provide the improved content with clear formatting
   - Include content ID for database updates
   - Include a summary of key improvements made
   - List specific optimizations applied (SEO, readability, engagement)
   - Provide content quality score (before and after if possible)
   - Note any recommendations for further optimization

${context}\n\nImprovement Parameters:\n${additionalContext.join('\n')}`
      : `Perform BULK IMPROVEMENT of all draft content for maximum business impact and consistency.

BULK IMPROVEMENT OBJECTIVES:
- Improve ALL content items simultaneously while maintaining consistency
- Enhance content quality, readability, and engagement across all pieces
- Optimize for SEO and target keywords while maintaining natural flow
- Align all content with brand voice and target audience preferences
- Improve structure, clarity, and call-to-action effectiveness
- Ensure all content meets current marketing goals and campaign objectives
- Maintain each content's original purpose while maximizing impact

BULK IMPROVEMENT GUIDELINES:
1. Content Analysis (for all items):
   - Assess current content strengths and weaknesses
   - Identify opportunities for SEO optimization
   - Evaluate alignment with target audience and brand voice
   - Check for clarity, flow, and engagement factors

2. Content Enhancement (for each item):
   - Improve headlines and subheadings for better impact
   - Enhance introductions and conclusions for stronger engagement
   - Optimize content structure and readability
   - Incorporate target keywords naturally
   - Strengthen call-to-action elements
   - Add relevant examples, statistics, or case studies if appropriate

3. Consistency Assurance:
   - Maintain consistent brand voice across all content
   - Ensure cohesive messaging and style
   - Apply uniform quality standards
   - Coordinate keyword usage across pieces

4. Deliverables (for each content item):
   - Provide the improved content with clear formatting
   - Include content ID for database updates
   - Include a summary of key improvements made
   - List specific optimizations applied (SEO, readability, engagement)
   - Provide content quality score (before and after if possible)
   - Note any recommendations for further optimization

${context}`;
    
    // Create the command using CommandFactory
    const command = CommandFactory.createCommand({
      task: 'bulk improve content',
      userId: effectiveUserId,
      agentId: effectiveAgentId,
      site_id: siteId,
      description: `Bulk improve and optimize ${draftContent.length} draft content items for site ${siteId} to enhance effectiveness, readability, and business impact while maintaining brand voice and optimizing for target keywords.`,
      // Set targets for all content items to be updated
      targets: draftContent.map(content => ({
        content_id: content.id,
        action: 'update',
        content: [{
          improvements_applied: ["List of specific improvements made"],
          text: "Improved markdown content with enhanced readability, SEO optimization, and engagement factors",
          title: "Enhanced and optimized title",
          description: "Improved and compelling description",
          original_score: "Content quality score before improvement",
          improvement_notes: "Summary of key improvements and optimizations applied",
          improved_score: "Content quality score after improvement"
        }]
      })),
      context: fullContext,
      supervisor: [
        {
          agent_role: 'growth_marketer',
          status: 'not_initialized'
        },
        {
          agent_role: 'growth_manager',
          status: 'not_initialized'
        }
      ]
    });
    
    // Submit the command for processing
    const internalCommandId = await commandService.submitCommand(command);
    console.log(`📝 Bulk content improvement command created with internal ID: ${internalCommandId}`);
    
    // Try to get database UUID immediately after creating command
    let initialDbUuid = await getCommandDbUuid(internalCommandId);
    if (initialDbUuid) {
      console.log(`📌 Database UUID obtained initially: ${initialDbUuid}`);
    }
    
    // Wait for command completion (longer timeout for bulk operations)
    const { command: executedCommand, dbUuid, completed } = await waitForCommandCompletion(internalCommandId);
    
    // Use initially obtained UUID if no valid one after execution
    const effectiveDbUuid = (dbUuid && isValidUUID(dbUuid)) ? dbUuid : initialDbUuid;
    
    if (!completed || !executedCommand) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'COMMAND_EXECUTION_FAILED', 
            message: 'The bulk content improvement command did not complete successfully in the expected time' 
          } 
        },
        { status: 500 }
      );
    }
    
    // Extract improved content from results
    let improvedContentItems = [];
    
    if (executedCommand.results && Array.isArray(executedCommand.results)) {
      const contentResult = executedCommand.results.find((r: any) => 
        r.type === 'content' || 
        (r.content && Array.isArray(r.content.content)) || 
        (Array.isArray(r.content))
      );
      
      if (contentResult) {
        if (contentResult.content && Array.isArray(contentResult.content.content)) {
          improvedContentItems = contentResult.content.content;
        } else if (Array.isArray(contentResult.content)) {
          improvedContentItems = contentResult.content;
        }
      }
    }
    
    if (improvedContentItems.length === 0) {
      console.error('No improved content found in command results');
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'NO_IMPROVED_CONTENT', 
            message: 'No improved content was generated by the agent' 
          } 
        },
        { status: 500 }
      );
    }
    
    console.log(`📊 Generated ${improvedContentItems.length} improved content items`);
    
    // Validate that we have the same number of improved items as original content
    if (improvedContentItems.length !== draftContent.length) {
      console.error(`❌ Mismatch: ${draftContent.length} original content items but ${improvedContentItems.length} improved items`);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'CONTENT_MISMATCH', 
            message: `Expected ${draftContent.length} improved content items but got ${improvedContentItems.length}` 
          } 
        },
        { status: 500 }
      );
    }
    
    // Map improved content to original content IDs with strict 1:1 correspondence
    const mappedResults = draftContent.map((originalContent, index) => {
      const improvedItem = improvedContentItems[index];
      if (!improvedItem) {
        console.error(`❌ No improved content found for index ${index}, contentId: ${originalContent.id}`);
        return null;
      }
      
      console.log(`🔄 Mapping original content ${originalContent.id} (index ${index}) -> improved content`);
      return {
        contentId: originalContent.id,
        improvedContent: improvedItem,
        originalContent
      };
    });
    
    // Filter out null entries and ensure type safety
    const improvementResults = mappedResults.filter((result): result is {contentId: string, improvedContent: any, originalContent: any} => result !== null);
    
    if (improvementResults.length === 0) {
      console.error('❌ No valid improvement results to process');
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'NO_VALID_IMPROVEMENTS', 
            message: 'No valid improvement results could be generated' 
          } 
        },
        { status: 500 }
      );
    }
    
    // Update all content in the database
    const { updated, failed } = await updateMultipleContentInDatabase(
      improvementResults, 
      effectiveUserId
    );
    
    if (updated.length === 0) {
      console.error('Failed to update any content in database');
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'DATABASE_UPDATE_FAILED', 
            message: 'Failed to update any improved content in the database' 
          } 
        },
        { status: 500 }
      );
    }
    
    return NextResponse.json(
      { 
        success: true, 
        data: { 
          command_id: effectiveDbUuid || internalCommandId,
          siteId,
          segmentId,
          campaignId,
          processed_count: draftContent.length,
          updated_count: updated.length,
          failed_count: failed.length,
          failed_content_ids: failed,
          original_content: draftContent.map(content => ({
            id: content.id,
            title: content.title,
            description: content.description,
            status: content.status
          })),
          improved_content: updated,
          improvements_summary: `Successfully improved ${updated.length} out of ${draftContent.length} content items`
        } 
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('Error processing bulk content improvement request:', error);
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'An error occurred while processing the bulk content improvement request' } },
      { status: 500 }
    );
  }
}

// GET endpoint to retrieve draft content for improvement
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const siteId = searchParams.get('siteId');
    const segmentId = searchParams.get('segmentId');
    const campaignId = searchParams.get('campaignId');
    const limit = parseInt(searchParams.get('limit') || '50');
    
    if (!siteId) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'siteId is required' } },
        { status: 400 }
      );
    }
    
    if (!isValidUUID(siteId)) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'siteId must be a valid UUID' } },
        { status: 400 }
      );
    }
    
    console.log(`Fetching draft content for site: ${siteId}`);
    
    // Get draft content
    const draftContent = await getDraftContentForSite(
      siteId, 
      segmentId || undefined, 
      campaignId || undefined, 
      undefined, // No specific content IDs for GET
      limit
    );
    
    return NextResponse.json(
      { 
        success: true, 
        data: { 
          siteId,
          segmentId,
          campaignId,
          draft_content: draftContent,
          total_items: draftContent.length
        } 
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('Error fetching draft content:', error);
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'An error occurred while fetching draft content' } },
      { status: 500 }
    );
  }
}