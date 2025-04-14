import { NextResponse } from 'next/server';
import { CommandFactory, AgentInitializer } from '@/lib/agentbase';
import { getCommandById as dbGetCommandById } from '@/lib/database/command-db';
import { DatabaseAdapter } from '@/lib/agentbase/adapters/DatabaseAdapter';
import { supabaseAdmin } from '@/lib/database/supabase-client';

// Function to validate UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
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
    const formattedItems = contentItems.map(item => ({
      title: item.title || '',
      description: item.description || '',
      text: item.text || item.content || '',
      type: item.type || 'blog_post',
      status: 'draft',
      site_id: siteId,
      segment_id: segmentId || null,
      campaign_id: campaignId || null,
      user_id: userId || 'system',
      metadata: {
        originalItem: item,
        schedule: item.schedule || null,
        topics: item.topics || [],
        keywords: item.keywords || [],
        estimated_reading_time: item.estimated_reading_time || null
      }
    }));
    
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
const agentInitializer = AgentInitializer.getInstance();
agentInitializer.initialize();
const commandService = agentInitializer.getCommandService();

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
    contextParts.push(`Site Information:\n${JSON.stringify(siteInfo, null, 2)}`);
  } else {
    contextParts.push(`Site ID: ${siteId} (no additional info available)`);
  }
  
  // Get segment information if available
  if (segmentId) {
    const segmentInfo = await getSegmentInfo(segmentId);
    if (segmentInfo) {
      contextParts.push(`Segment Information:\n${JSON.stringify(segmentInfo, null, 2)}`);
    } else {
      contextParts.push(`Segment ID: ${segmentId} (no additional info available)`);
    }
  }
  
  // Get campaign information if available
  if (campaignId) {
    const campaignInfo = await getCampaignInfo(campaignId);
    if (campaignInfo) {
      contextParts.push(`Campaign Information:\n${JSON.stringify(campaignInfo, null, 2)}`);
    } else {
      contextParts.push(`Campaign ID: ${campaignId} (no additional info available)`);
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
    
    // Get default agent ID if not provided
    const effectiveAgentId = agent_id || 'default_copywriter_agent';
    const effectiveUserId = userId || 'system';
    
    console.log(`Creating command for agent: ${effectiveAgentId}, site: ${siteId}`);
    
    // Build context with site, segment, and campaign information
    const context = await buildContext(siteId, segmentId, campaignId);
    
    // Additional context from request parameters
    let additionalContext = [];
    
    if (timeframe) additionalContext.push(`Timeframe: ${timeframe}`);
    if (contentType) additionalContext.push(`Content Type: ${contentType}`);
    if (targetAudience) additionalContext.push(`Target Audience: ${targetAudience}`);
    if (goals && Array.isArray(goals)) additionalContext.push(`Goals: ${goals.join(', ')}`);
    if (keywords && Array.isArray(keywords)) additionalContext.push(`Keywords: ${keywords.join(', ')}`);
    
    const fullContext = additionalContext.length > 0 
      ? `${context}\n\nAdditional Parameters:\n${additionalContext.join('\n')}` 
      : context;
    
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
          text: "Rich markdown detailed copy, add line breaks for readability and formatting",
          title: "title of the content",
          description: "summary of the content",
          estimated_reading_time: "Number of estimated reading time in seconds, ex 60"
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
      
      if (executedCommand.results && Array.isArray(executedCommand.results)) {
        // Try to find content using different possible paths
        const contentResult = executedCommand.results.find((r: any) => 
          r.type === 'content' || 
          (r.content && Array.isArray(r.content.content)) || 
          (Array.isArray(r.content))
        );
        
        if (contentResult) {
          // Handle different content structures
          if (contentResult.content && Array.isArray(contentResult.content.content)) {
            contentResults = contentResult.content.content;
          } else if (Array.isArray(contentResult.content)) {
            contentResults = contentResult.content;
          } else if (contentResult.type === 'content' && Array.isArray(contentResult)) {
            contentResults = contentResult;
          }
        } else {
          // Direct array of content object structure
          const directContentArray = executedCommand.results.find((r: any) => 
            r.content && Array.isArray(r.content)
          );
          
          if (directContentArray) {
            contentResults = directContentArray.content;
          }
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
    
    if (executedCommand.results && Array.isArray(executedCommand.results)) {
      // Try to find content using different possible paths
      const contentResult = executedCommand.results.find((r: any) => 
        r.type === 'content' || 
        (r.content && Array.isArray(r.content.content)) || 
        (Array.isArray(r.content))
      );
      
      if (contentResult) {
        // Handle different content structures
        if (contentResult.content && Array.isArray(contentResult.content.content)) {
          contentResults = contentResult.content.content;
        } else if (Array.isArray(contentResult.content)) {
          contentResults = contentResult.content;
        } else if (contentResult.type === 'content' && Array.isArray(contentResult)) {
          contentResults = contentResult;
        }
      } else {
        // Direct array of content object structure
        const directContentArray = executedCommand.results.find((r: any) => 
          r.content && Array.isArray(r.content)
        );
        
        if (directContentArray) {
          contentResults = directContentArray.content;
        }
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