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
async function findContentCreatorAgent(siteId: string): Promise<{agentId: string, userId: string} | null> {
  try {
    if (!siteId || !isValidUUID(siteId)) {
      console.error(`❌ Invalid site_id for content creator agent search: ${siteId}`);
      return null;
    }
    
    console.log(`🔍 Buscando agente con rol "Content Creator & Copywriter" para el sitio: ${siteId}`);
    
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
      console.error('Error al buscar agente con rol "Content Creator & Copywriter":', error);
      return null;
    }
    
    if (!data || data.length === 0) {
      console.log(`⚠️ No se encontró ningún agente con rol "Content Creator & Copywriter" activo para el sitio: ${siteId}`);
      return null;
    }
    
    console.log(`✅ Agente con rol "Content Creator & Copywriter" encontrado: ${data[0].id} (user_id: ${data[0].user_id})`);
    return {
      agentId: data[0].id,
      userId: data[0].user_id
    };
  } catch (error) {
    console.error('Error al buscar agente de tipo Content Creator:', error);
    return null;
  }
}

// Function to save content items to the database
async function saveContentItemsToDatabase(
  contentItems: any[],
  siteId: string,
  segmentId?: string,
  campaignId?: string,
  userId?: string
): Promise<any[]> {
  try {
    if (!contentItems || !Array.isArray(contentItems) || contentItems.length === 0) {
      console.log('No content items to save');
      return [];
    }
    
    console.log(`Saving ${contentItems.length} content items to database`);
    
    // Map content items to database structure
    const formattedItems = contentItems.map((item: any, index: number) => {
      const contentType = item.type;
      console.log(`💾 Guardando contenido ${index + 1}:`, {
        title: item.title?.substring(0, 50) + '...',
        type: contentType,
        hasType: !!contentType,
        hasInstructions: !!item.instructions,
        textLength: item.text?.length || 0,
        instructionsLength: item.instructions?.length || 0
      });
      
      // Debug: Log the full item structure for the first content piece
      if (index === 0) {
        console.log(`🔍 Debug item structure:`, JSON.stringify(item, null, 2));
      }
      
      return {
        title: item.title || '',
        description: item.description || '',
        text: item.text || '', // Only use the text property, not concatenated content
        instructions: item.instructions || '', // Strategic instructions and execution details
        type: contentType, // Use exact type returned by agent
        status: 'draft',
        site_id: siteId,
        segment_id: segmentId || null,
        campaign_id: campaignId || null,
        user_id: userId || 'system',
        estimated_reading_time: item.estimated_reading_time ? parseInt(item.estimated_reading_time, 10) : null,
        metadata: {
          schedule: item.schedule || null,
          topics: item.topics || [],
          keywords: item.keywords || [],
          // Solo guardar campos adicionales que no están mapeados directamente
          ...(item.target_audience && { target_audience: item.target_audience }),
          ...(item.business_goal && { business_goal: item.business_goal }),
          ...(item.distribution_channels && { distribution_channels: item.distribution_channels }),
          ...(item.publishing_date && { publishing_date: item.publishing_date })
        }
      };
    });
    
    // Insert into content table (was previously content_items)
    const { data, error } = await supabaseAdmin
      .from('content')
      .insert(formattedItems)
      .select();
    
    if (error) {
      console.error('Error saving content items to database:', error);
      // Log error but don't throw - just return empty array
      const errorMessage = error.message || 'Unknown database error';
      console.error(`Failed to save content items: ${errorMessage}`);
      return [];
    }
    
    console.log(`Successfully saved ${data ? data.length : 0} content items to database`);
    return data || [];
  } catch (error: any) {
    // Handle any unexpected errors
    const errorMessage = error?.message || 'Unknown error in saveContentItemsToDatabase';
    console.error('Error in saveContentItemsToDatabase:', errorMessage);
    // Always return an empty array instead of throwing
    return [];
  }
}

// Initialize agent and get command service
const processorInitializer = ProcessorInitializer.getInstance();
processorInitializer.initialize();
const commandService = processorInitializer.getCommandService();

// Function to get the DB UUID for a command
async function getCommandDbUuid(internalId: string): Promise<string | null> {
  try {
    // Try to get the command
    const command = await commandService.getCommandById(internalId);
    
    // Check metadata
    if (command && command.metadata && command.metadata.dbUuid) {
      if (isValidUUID(command.metadata.dbUuid)) {
        console.log(`🔑 UUID found in metadata: ${command.metadata.dbUuid}`);
        return command.metadata.dbUuid;
      }
    }
    
    // Check internal translation map
    try {
      // This is a hack to access the internal translation map
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
    
    // Search directly in database
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
async function waitForCommandCompletion(commandId: string, maxAttempts = 60, delayMs = 1000) {
  let executedCommand = null;
  let attempts = 0;
  let dbUuid: string | null = null;
  
  console.log(`⏳ Waiting for command ${commandId} to complete...`);
  
  // Create a promise that resolves when the command completes or times out
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
        
        // Save database UUID if available
        if (executedCommand.metadata && executedCommand.metadata.dbUuid) {
          dbUuid = executedCommand.metadata.dbUuid as string;
          console.log(`🔑 Database UUID found in metadata: ${dbUuid}`);
        }
        
        if (executedCommand.status === 'completed' || executedCommand.status === 'failed') {
          console.log(`✅ Command ${commandId} completed with status: ${executedCommand.status}`);
          
          // Try to get database UUID if we don't have it yet
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
          
          // Final attempt to get UUID
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
async function buildContext(siteId: string, segmentId?: string, campaignId?: string): Promise<string> {
  let contextParts = [];
  
  // Get site information
  const siteInfo = await getSiteInfo(siteId);
  if (siteInfo) {
    // Extract the most relevant site data and format it in a more structured way
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
  } else {
    contextParts.push(`SITE INFORMATION:\n- Site ID: ${siteId}\n- Note: No additional site information available`);
  }
  
  // Get segment information if available
  if (segmentId) {
    const segmentInfo = await getSegmentInfo(segmentId);
    if (segmentInfo) {
      // Extract and format the most relevant segment data
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
    } else {
      contextParts.push(`AUDIENCE SEGMENT INFORMATION:\n- Segment ID: ${segmentId}\n- Note: No additional segment information available`);
    }
  }
  
  // Get campaign information if available
  if (campaignId) {
    const campaignInfo = await getCampaignInfo(campaignId);
    if (campaignInfo) {
      // Extract and format the most relevant campaign data
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
    } else {
      contextParts.push(`CAMPAIGN INFORMATION:\n- Campaign ID: ${campaignId}\n- Note: No additional campaign information available`);
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
      segmentId, 
      campaignId, 
      userId, 
      agent_id, 
      timeframe, 
      contentType, 
      targetAudience, 
      goals, 
      keywords 
    } = body;
    
    if (!siteId) {
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
    
    // Determine the user ID from the request or agent
    let effectiveUserId = userId;
    let effectiveAgentId = agent_id;
    
    // Si no se proporciona agent_id, buscar uno para el sitio
    if (!effectiveAgentId) {
      const foundAgent = await findContentCreatorAgent(siteId);
      if (foundAgent) {
        effectiveAgentId = foundAgent.agentId;
        if (!effectiveUserId) {
          effectiveUserId = foundAgent.userId;
        }
        console.log(`🤖 Usando agente con rol "Content Creator & Copywriter" encontrado: ${effectiveAgentId} (user_id: ${effectiveUserId})`);
      } else {
        // Use default agent if no specific agent found
        effectiveAgentId = 'default_copywriter_agent';
        console.log(`🤖 No se encontró agente específico, usando agente por defecto: ${effectiveAgentId}`);
      }
    }
    
    // Set fallback userId if still not defined
    if (!effectiveUserId) {
      effectiveUserId = 'system';
    }
    
    console.log(`Creating command for agent: ${effectiveAgentId}, site: ${siteId}`);
    
    // Build context with site, segment, and campaign information
    const context = await buildContext(siteId, segmentId, campaignId);
    
    // Additional context from request parameters
    let additionalContext = [];

    if (timeframe) {
      additionalContext.push(`TIMEFRAME: ${timeframe}`);
    }

    if (contentType) {
      // Handle both string and array formats
      const formattedContentTypes = Array.isArray(contentType) 
        ? contentType.join(', ') 
        : contentType;
      additionalContext.push(`CONTENT TYPES: ${formattedContentTypes}`);
    }

    if (targetAudience) {
      // Handle both string and array formats
      const formattedAudience = Array.isArray(targetAudience) 
        ? targetAudience.join(', ') 
        : targetAudience;
      additionalContext.push(`TARGET AUDIENCE: ${formattedAudience}`);
    }

    if (goals && Array.isArray(goals) && goals.length > 0) {
      additionalContext.push(`BUSINESS & MARKETING GOALS:`);
      goals.forEach((goal, index) => {
        additionalContext.push(`  ${index + 1}. ${goal}`);
      });
    }

    if (keywords && Array.isArray(keywords) && keywords.length > 0) {
      additionalContext.push(`FOCUS KEYWORDS & TOPICS:`);
      
      // Group keywords in sets of 5 for better readability
      const groupedKeywords = [];
      for (let i = 0; i < keywords.length; i += 5) {
        const group = keywords.slice(i, i + 5).join(', ');
        groupedKeywords.push(`  • ${group}`);
      }
      
      additionalContext.push(groupedKeywords.join('\n'));
    }
    
    // Build the base context template
    const baseContextTemplate = `Generate a strategic content calendar optimized for maximum business impact.

OBJECTIVES:
- Create comprehensive, data-driven content ideas aligned with business goals
- Develop a balanced mix of content types and formats to engage different audience segments
- Include detailed information for each content piece (title, description, keywords, estimated reading time, type)
- Ensure all content aligns with marketing strategy, SEO goals, and brand voice
- Optimize publishing schedule for maximum audience engagement
- Provide strategic rationale for topic selection and content types

CONTENT TYPE OPTIONS (AUTHORIZED VALUES ONLY):
Choose from ONLY these authorized values: blog_post, video, podcast, social_post, newsletter, case_study, whitepaper, infographic, webinar, ebook, ad, landing_page

TYPE DESCRIPTIONS:
- blog_post: Blog Post
- video: Video content
- podcast: Podcast episode
- social_post: Social Media Post
- newsletter: Newsletter content
- case_study: Case Study
- whitepaper: Whitepaper
- infographic: Infographic
- webinar: Webinar content
- ebook: E-Book
- ad: Advertisement
- landing_page: Landing Page (only if required by the business goals)

CONTENT STRUCTURE GUIDELINES:
1. Create at least 8-12 distinct content pieces organized chronologically
2. For each content item include:
   - Clear, compelling title (50-60 characters)
   - Concise but descriptive summary (100-150 characters)
   - Content type/format (choose from the authorized options above based on strategy and goals)
   - Primary topic and 3-5 related keywords
   - Estimated reading/viewing time in seconds
   - Optimal publishing date or timeframe
   - Specific target audience segment
   - Business goal this content supports
   - Brief strategic notes on execution

STRATEGIC CONSIDERATIONS:
- Consider the business goals and the target audience to create the content
- Consider the budget, team size, and resources available to create the content
- Distribute content types across marketing funnel (awareness, consideration, decision)
- Include a mix of evergreen and timely/seasonal content
- Create topic clusters around primary keywords for improved SEO impact
- Balance content frequency based on available resources and audience engagement patterns
- Consider repurposing opportunities (e.g., blog post → infographic → social media series)
- Plan content that aligns with specific conversion goals and sales cycles

CALENDAR FORMAT:
- If not specified, make a week of content at least
- Organize content chronologically by week/month
- Group related content to create thematic campaigns where appropriate
- Include content distribution channels for each piece
- Note any dependencies between content items

CONTENT OUTPUT FORMAT:
Split your response into TWO SEPARATE FIELDS:

1. "text" field: ONLY the final copy/content ready to be published
   - Rich markdown detailed copy, add line breaks for readability and formatting
   - Be creative and engaging
   - NO strategic notes, NO distribution info, NO SEO keywords lists
   - ONLY the actual content that readers will see

2. "instructions" field: ALL strategic and tactical information
   - Distribution guidelines and channel recommendations
   - SEO keywords and optimization notes
   - Target audience segments and conversion goals
   - Repurposing opportunities and dependencies
   - Execution details and tactical notes for marketers
   - Publishing schedule and strategic rationale

CRITICAL: Keep these completely separate. The "text" should be clean copy without any meta-information.
${context}`;

    // Add additional parameters if they exist
    const fullContext = additionalContext.length > 0 
      ? `${baseContextTemplate}\n\nAdditional Parameters:\n${additionalContext.join('\n')}`
      : baseContextTemplate;
    
    // Create the command using CommandFactory
    const command = CommandFactory.createCommand({
      task: 'create content calendar',
      userId: effectiveUserId,
      agentId: effectiveAgentId,
      // Add site_id as a basic property if it exists
      ...(siteId ? { site_id: siteId } : {}),
      description: 'Generate a comprehensive content calendar with strategic content ideas aligned with marketing goals, focused on the target audience, and optimized for the specified keywords and timeframe.',
      // Set the target for content generation
      targets: [{
        content: [{
          type: "Type of content from ONLY these authorized values: blog_post, video, podcast, social_post, newsletter, case_study, whitepaper, infographic, webinar, ebook, ad, landing_page. Choose the most appropriate type for each content piece.",
          text: "Rich detailed copy with proper formatting and line breaks for readability",
          title: "Clear, compelling title for the content piece", 
          description: "Brief, descriptive summary of the content",
          instructions: "Strategic instructions, notes, distribution guidelines, SEO considerations, and execution details for this content piece",
          estimated_reading_time: "Reading time in seconds as integer (e.g., 60, 120, 240)"
        }]
      }],
      // No tools for this command
      // Context includes site, segment, and campaign info
      context: fullContext,
      // Add supervisors
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
    console.log(`📝 Command created with internal ID: ${internalCommandId}`);
    
    // Try to get database UUID immediately after creating command
    let initialDbUuid = await getCommandDbUuid(internalCommandId);
    if (initialDbUuid) {
      console.log(`📌 Database UUID obtained initially: ${initialDbUuid}`);
    }
    
    // Wait for command completion
    const { command: executedCommand, dbUuid, completed } = await waitForCommandCompletion(internalCommandId);
    
    // Use initially obtained UUID if no valid one after execution
    const effectiveDbUuid = (dbUuid && isValidUUID(dbUuid)) ? dbUuid : initialDbUuid;
    
    // Check that we have a valid database UUID
    if (!effectiveDbUuid || !isValidUUID(effectiveDbUuid)) {
      console.error(`❌ Could not obtain a valid database UUID for command ${internalCommandId}`);
      
      // Continue with internal ID as fallback
      console.log(`⚠️ Continuing with internal ID as fallback: ${internalCommandId}`);
      
      if (!completed || !executedCommand) {
        return NextResponse.json(
          { 
            success: false, 
            error: { 
              code: 'COMMAND_EXECUTION_FAILED', 
              message: 'The command did not complete successfully in the expected time' 
            } 
          },
          { status: 500 }
        );
      }
      
      // Extract content from results
      let contentResults = [];
      
      console.log(`🔍 Debug: executedCommand.results structure:`, JSON.stringify(executedCommand.results, null, 2));
      
      if (executedCommand.results && Array.isArray(executedCommand.results)) {
        // Extract content as defined in targets: [{ content: [...] }]
        for (const result of executedCommand.results) {
          if (result.content && Array.isArray(result.content)) {
            // Direct content array as defined in targets: { content: [items] }
            contentResults = result.content;
            console.log(`✅ Found content array with ${contentResults.length} items`);
            break;
          }
        }
        
        // If no content found, log the structure for debugging
        if (contentResults.length === 0) {
          console.log(`⚠️ No content found. Available result keys:`, 
            executedCommand.results.map((r: any) => Object.keys(r)).flat()
          );
        }
      }
      
      console.log(`📊 Generated ${contentResults.length} content items`);
      
      // Save content items to database
      let savedContentItems = [];
      let savedToDatabase = false;
      
      if (contentResults.length > 0) {
        try {
          // Attempt to save to database, but if it fails, we'll still return the content
          savedContentItems = await saveContentItemsToDatabase(
            contentResults, 
            siteId, 
            segmentId, 
            campaignId, 
            effectiveUserId
          );
          
          // Set the saved flag based on whether we have saved items
          savedToDatabase = savedContentItems && savedContentItems.length > 0;
        } catch (error) {
          // This should never happen now since saveContentItemsToDatabase doesn't throw,
          // but we'll handle it just in case
          console.error('Failed to save content to database:', error);
          savedToDatabase = false;
          savedContentItems = [];
        }
      }
      
      // Prepare the response - always include content, even if database save failed
      const responseContent = savedContentItems.length > 0 ? savedContentItems : contentResults;
      
      // Respond using internal ID as fallback
      return NextResponse.json(
        { 
          success: true, 
          data: { 
            command_id: internalCommandId, // Use internal ID as fallback
            siteId,
            segmentId,
            campaignId,
            content: responseContent,
            saved_to_database: savedToDatabase
          } 
        },
        { status: 200 }
      );
    }
    
    if (!completed || !executedCommand) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'COMMAND_EXECUTION_FAILED', 
            message: 'The command did not complete successfully in the expected time' 
          } 
        },
        { status: 500 }
      );
    }
    
    // Extract content from results
    let contentResults = [];
    
    console.log(`🔍 Debug: executedCommand.results structure:`, JSON.stringify(executedCommand.results, null, 2));
    
    if (executedCommand.results && Array.isArray(executedCommand.results)) {
      // Extract content as defined in targets: [{ content: [...] }]
      for (const result of executedCommand.results) {
        if (result.content && Array.isArray(result.content)) {
          // Direct content array as defined in targets: { content: [items] }
          contentResults = result.content;
          console.log(`✅ Found content array with ${contentResults.length} items`);
          break;
        }
      }
      
      // If no content found, log the structure for debugging
      if (contentResults.length === 0) {
        console.log(`⚠️ No content found. Available result keys:`, 
          executedCommand.results.map((r: any) => Object.keys(r)).flat()
        );
      }
    }
    
    console.log(`📊 Generated ${contentResults.length} content items`);
    
    // Save content items to database
    let savedContentItems = [];
    let savedToDatabase = false;
    
    if (contentResults.length > 0) {
      try {
        // Attempt to save to database, but if it fails, we'll still return the content
        savedContentItems = await saveContentItemsToDatabase(
          contentResults, 
          siteId, 
          segmentId, 
          campaignId, 
          effectiveUserId
        );
        
        // Set the saved flag based on whether we have saved items
        savedToDatabase = savedContentItems && savedContentItems.length > 0;
      } catch (error) {
        // This should never happen now since saveContentItemsToDatabase doesn't throw,
        // but we'll handle it just in case
        console.error('Failed to save content to database:', error);
        savedToDatabase = false;
        savedContentItems = [];
      }
    }
    
    // Prepare the response - always include content, even if database save failed
    const responseContent = savedContentItems.length > 0 ? savedContentItems : contentResults;
    
    return NextResponse.json(
      { 
        success: true, 
        data: { 
          command_id: effectiveDbUuid,
          siteId,
          segmentId,
          campaignId,
          content: responseContent,
          saved_to_database: savedToDatabase
        } 
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('Error processing request:', error);
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'An error occurred while processing the request' } },
      { status: 500 }
    );
  }
} 