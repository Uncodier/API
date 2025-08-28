import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { DatabaseAdapter } from '@/lib/agentbase/adapters/DatabaseAdapter';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';
import { 
  getLeadInfo, 
  getPreviousInteractions, 
  buildEnrichedContext,
  safeStringify
} from '@/lib/helpers/lead-context-helper';

// Function to validate UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Initialize agent and get command service
const processorInitializer = ProcessorInitializer.getInstance();
processorInitializer.initialize();
const commandService = processorInitializer.getCommandService();

// Function to get database UUID for a command
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
    
    // Search in CommandService internal translation map
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
    
    // Search in database directly by some field that might relate
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



// Generic function to find an active agent by role
async function findActiveAgentByRole(siteId: string, role: string): Promise<{agentId: string, userId: string} | null> {
  try {
    if (!siteId || !isValidUUID(siteId)) {
      console.error(`❌ Invalid site_id for agent search: ${siteId}`);
      return null;
    }
    
    console.log(`🔍 Searching for active agent with role "${role}" for site: ${siteId}`);
    
    // Only search by site_id, role and status
    const { data, error } = await supabaseAdmin
      .from('agents')
      .select('id, user_id')
      .eq('site_id', siteId)
      .eq('role', role)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1);
    
    if (error) {
      console.error(`Error searching for agent with role "${role}":`, error);
      return null;
    }
    
    if (!data || data.length === 0) {
      console.log(`⚠️ No active agent found with role "${role}" for site: ${siteId}`);
      return null;
    }
    
    console.log(`✅ Agent with role "${role}" found: ${data[0].id} (user_id: ${data[0].user_id})`);
    return {
      agentId: data[0].id,
      userId: data[0].user_id
    };
  } catch (error) {
    console.error(`Error searching for agent with role "${role}":`, error);
    return null;
  }
}

// Function to find an active sales agent for a site
async function findActiveSalesAgent(siteId: string): Promise<{agentId: string, userId: string} | null> {
  return await findActiveAgentByRole(siteId, 'Sales/CRM Specialist');
}

// Function to find an active copywriter for a site
async function findActiveCopywriter(siteId: string): Promise<{agentId: string, userId: string} | null> {
  return await findActiveAgentByRole(siteId, 'Content Creator & Copywriter');
}

// Function to get site channel configuration
async function getSiteChannelsConfiguration(siteId: string): Promise<{
  hasChannels: boolean,
  configuredChannels: string[],
  channelsDetails: Record<string, any>,
  warning?: string
}> {
  try {
    console.log(`📡 Getting channel configuration for site: ${siteId}`);
    
    const { data, error } = await supabaseAdmin
      .from('settings')
      .select('channels')
      .eq('site_id', siteId)
      .single();
    
    if (error || !data?.channels) {
      const warning = `⚠️ Site ${siteId} has NO channels configured in settings. Cannot process message without channels.`;
      console.warn(warning);
      
      return {
        hasChannels: false,
        configuredChannels: [],
        channelsDetails: {},
        warning: 'No channels configured'
      };
    }
    
    const channels = data.channels;
    const configuredChannels: string[] = [];
    const channelsDetails: Record<string, any> = {};
    
    // Check each available channel type
    if (channels.email && (channels.email.email || channels.email.aliases)) {
      configuredChannels.push('email');
      channelsDetails.email = {
        type: 'email',
        email: channels.email.email || null,
        aliases: channels.email.aliases || [],
        description: 'Email marketing and outreach'
      };
    }
    
    if (channels.whatsapp && channels.whatsapp.phone_number) {
      configuredChannels.push('whatsapp');
      channelsDetails.whatsapp = {
        type: 'whatsapp',
        phone_number: channels.whatsapp.phone_number,
        description: 'WhatsApp Business messaging'
      };
    }
    
    return {
      hasChannels: configuredChannels.length > 0,
      configuredChannels,
      channelsDetails
    };
    
  } catch (error) {
    console.error('Error getting site channel configuration:', error);
    return {
      hasChannels: false,
      configuredChannels: [],
      channelsDetails: {},
      warning: 'Error retrieving channel configuration'
    };
  }
}

// Function to trigger channels setup required notification
async function triggerChannelsSetupNotification(siteId: string): Promise<void> {
  try {
    console.log(`📧 CHANNELS SETUP: Triggering notification for site: ${siteId}`);
    
    // Make internal API call to channels setup notification endpoint
    const response = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}/api/notifications/channelsSetupRequired`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        site_id: siteId
      })
    });
    
    if (response.ok) {
      const result = await response.json();
      console.log(`✅ CHANNELS SETUP: Notification triggered successfully for site: ${siteId}`);
      console.log(`📊 CHANNELS SETUP: Result:`, result);
    } else {
      const error = await response.json();
      console.error(`❌ CHANNELS SETUP: Failed to trigger notification for site: ${siteId}`, error);
    }
  } catch (error) {
    console.error(`❌ CHANNELS SETUP: Error triggering notification for site: ${siteId}:`, error);
  }
}

// Function to manually filter and correct channel based on site configuration
function filterAndCorrectMessageChannel(
  messages: any,
  configuredChannels: string[]
): { correctedMessages: any, corrections: string[] } {
  console.log(`🔧 CHANNEL FILTER: Starting manual channel filtering...`);
  console.log(`🔧 CHANNEL FILTER: Configured channels: [${configuredChannels.join(', ')}]`);
  console.log(`🔧 CHANNEL FILTER: Original messages channels: [${Object.keys(messages).join(', ')}]`);
  
  const corrections: string[] = [];
  const correctedMessages: any = {};
  
  // Process each message channel
  for (const [originalChannel, messageData] of Object.entries(messages)) {
    console.log(`🔧 CHANNEL FILTER: Processing channel: ${originalChannel}`);
    
    let targetChannel = originalChannel;
    let needsCorrection = false;
    
    // Manual filtering logic
    if (originalChannel === 'whatsapp' && !configuredChannels.includes('whatsapp')) {
      // WhatsApp message but no WhatsApp configured -> try email
      if (configuredChannels.includes('email')) {
        targetChannel = 'email';
        needsCorrection = true;
        corrections.push(`Changed ${originalChannel} → ${targetChannel} (WhatsApp not configured)`);
        console.log(`🔧 CHANNEL FILTER: ✅ WhatsApp → Email (WhatsApp not configured)`);
      } else {
        console.log(`🔧 CHANNEL FILTER: ❌ WhatsApp not configured and no email alternative`);
        continue; // Skip this message if no alternative
      }
    } 
    else if (originalChannel === 'email' && !configuredChannels.includes('email')) {
      // Email message but no email configured -> try WhatsApp
      if (configuredChannels.includes('whatsapp')) {
        targetChannel = 'whatsapp';
        needsCorrection = true;
        corrections.push(`Changed ${originalChannel} → ${targetChannel} (Email not configured)`);
        console.log(`🔧 CHANNEL FILTER: ✅ Email → WhatsApp (Email not configured)`);
      } else {
        console.log(`🔧 CHANNEL FILTER: ❌ Email not configured and no WhatsApp alternative`);
        continue; // Skip this message if no alternative
      }
    }
    else if (configuredChannels.includes(originalChannel)) {
      // Channel is properly configured
      console.log(`🔧 CHANNEL FILTER: ✅ ${originalChannel} is properly configured`);
    }
    else {
      // Channel not supported or not configured, skip
      console.log(`🔧 CHANNEL FILTER: ⚠️ Skipping ${originalChannel} (not configured)`);
      continue;
    }
    
    // Add message to corrected messages
    correctedMessages[targetChannel] = {
      ...(typeof messageData === 'object' && messageData !== null ? messageData : {}),
      channel: targetChannel
    };
    
    // Add correction metadata if needed
    if (needsCorrection) {
      correctedMessages[targetChannel].original_channel = originalChannel;
      correctedMessages[targetChannel].correction_reason = `Original channel '${originalChannel}' not configured, switched to '${targetChannel}'`;
    }
    
    console.log(`🔧 CHANNEL FILTER: Message added for channel: ${targetChannel}`);
  }
  
  console.log(`🔧 CHANNEL FILTER: Filtering completed`);
  console.log(`🔧 CHANNEL FILTER: Final channels: [${Object.keys(correctedMessages).join(', ')}]`);
  console.log(`🔧 CHANNEL FILTER: Corrections applied: ${corrections.length}`);
  
  return {
    correctedMessages,
    corrections
  };
}

// Function to wait for command completion
async function waitForCommandCompletion(commandId: string, maxAttempts = 100, delayMs = 1000) {
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
          
          // Try to get database UUID if we still don't have it
          if (!dbUuid || !isValidUUID(dbUuid)) {
            dbUuid = await getCommandDbUuid(commandId);
            console.log(`🔍 UUID obtained after completion: ${dbUuid || 'Not found'}`);
          }
          
          clearInterval(checkInterval);
          
          // Consider a command "completed" if:
          // 1. Status is 'completed', OR
          // 2. Status is 'failed' but has valid results (error was handled gracefully)
          const hasValidResults = executedCommand.results && executedCommand.results.length > 0;
          const isEffectivelyCompleted = executedCommand.status === 'completed' || 
                                       (executedCommand.status === 'failed' && hasValidResults);
          
          console.log(`📊 Command ${commandId} analysis: status=${executedCommand.status}, hasResults=${hasValidResults}, effectivelyCompleted=${isEffectivelyCompleted}`);
          
          resolve({command: executedCommand, dbUuid, completed: isEffectivelyCompleted});
          return;
        }
        
        console.log(`⏳ Command ${commandId} still running (status: ${executedCommand.status}), attempt ${attempts}/${maxAttempts}`);
        
        if (attempts >= maxAttempts) {
          console.log(`⏰ Timeout reached for command ${commandId}`);
          
          // Last attempt to get UUID
          if (!dbUuid || !isValidUUID(dbUuid)) {
            dbUuid = await getCommandDbUuid(commandId);
            console.log(`🔍 UUID obtained before timeout: ${dbUuid || 'Not found'}`);
          }
          
          clearInterval(checkInterval);
          resolve({command: executedCommand, dbUuid, completed: false});
        }
      } catch (error) {
        console.error(`Error checking status of command ${commandId}:`, error);
        clearInterval(checkInterval);
        resolve({command: null, dbUuid: null, completed: false});
      }
    }, delayMs);
  });
}

// Function to execute copywriter refinement
async function executeCopywriterRefinement(
  siteId: string,
  agentId: string,
  userId: string,
  baseContext: string,
  salesFollowUpContent: any,
  leadId: string
): Promise<{ commandId: string; dbUuid: string | null; command: any } | null> {
  try {
    console.log(`📝 PHASE 2: Executing copywriter refinement for agent: ${agentId}`);
    
    // Prepare context for second phase including first phase results
    console.log(`📝 PHASE 2: Preparing context for copywriter...`);
    let copywriterContext = baseContext;
    
    // Add first phase results to context
    if (salesFollowUpContent && typeof salesFollowUpContent === 'object') {
      console.log(`📝 PHASE 2: Adding phase 1 results to context`);
      copywriterContext += `\n\n--- SALES TEAM INPUT (Phase 1 Results) ---\n`;
      copywriterContext += `The Sales/CRM Specialist has provided the following initial follow-up content that you need to refine:\n\n`;
      
      copywriterContext += `SELECTED CONTENT:\n`;
      copywriterContext += `├─ Channel: ${salesFollowUpContent.channel || 'Not specified'}\n`;
      copywriterContext += `├─ Title: ${salesFollowUpContent.title || 'Not specified'}\n`;
      copywriterContext += `├─ Strategy: ${salesFollowUpContent.strategy || 'Not specified'}\n`;
      copywriterContext += `└─ Message: ${salesFollowUpContent.message || 'Not specified'}\n\n`;
      
      copywriterContext += `--- COPYWRITER INSTRUCTIONS ---\n`;
      copywriterContext += `Your task is to IMPROVE and ENHANCE the sales content above, not to replace it completely.\n`;
      copywriterContext += `The sales team has already done excellent strategic work selecting the right channel and approach.\n`;
      copywriterContext += `IMPORTANT: The sales team has already selected the most effective channel (${salesFollowUpContent.channel}) to avoid overwhelming the lead.\n`;
      copywriterContext += `Your role is to POLISH and REFINE what they've created. For the selected content, you must:\n`;
      copywriterContext += `1. PRESERVE the original CHANNEL (${salesFollowUpContent.channel}) and overall strategy\n`;
      copywriterContext += `2. MAINTAIN the core sales message and intent - don't change the fundamental approach\n`;
      copywriterContext += `3. ENHANCE the TITLE to make it more engaging while keeping the same purpose\n`;
      copywriterContext += `4. IMPROVE the MESSAGE with better copywriting flow, clarity, and persuasion techniques\n`;
      copywriterContext += `5. OPTIMIZE language for better emotional connection while preserving sales objectives\n`;
      copywriterContext += `6. STRENGTHEN calls-to-action without changing the intended next step\n`;
      copywriterContext += `7. DO NOT use placeholders or variables like [Name], {Company}, {{Variable}}, etc.\n`;
      copywriterContext += `8. Use ONLY the real information provided in the lead context\n`;
      copywriterContext += `9. Write final content ready to send without additional editing\n`;
      copywriterContext += `10. SIGNATURE RULES: ALL CHANNELS already include automatic signatures/identifications, so DO NOT add any signature or sign-off\n`;
      copywriterContext += `11. INTRODUCTION RULES: When introducing yourself or the company, always speak about the COMPANY, its RESULTS, ACHIEVEMENTS, or SERVICES - never about yourself as a person\n`;
      copywriterContext += `12. Focus on company value proposition, case studies, testimonials, or business outcomes rather than personal introductions\n`;
      copywriterContext += `13. 🎯 COPYWRITING APPROVAL PRIORITY: If there are approved copywritings available for this lead/campaign, respect them as much as possible. Only personalize with lead-specific information (name, company, pain points) to increase conversion. Maintain approved tone, structure, and core messaging.\n`;
      copywriterContext += `14. 🔑 KEY PRINCIPLE: Think of yourself as a writing coach helping the sales team express their ideas more effectively, not as someone replacing their work.\n\n`;
      
      console.log(`📝 PHASE 2: Structured context prepared with ${copywriterContext.length} characters`);
    } else {
      console.log(`⚠️ PHASE 2: No follow-up content found in sales results`);
    }
    
    // Create command for copywriter based on available channels from phase 1
    console.log(`🏗️ PHASE 2: Creating command for copywriter...`);
    console.log(`🏗️ PHASE 2: Parameters - userId: ${userId}, agentId: ${agentId}, siteId: ${siteId}`);
    
    // Build refinement target based on phase 1 content
    let refinementTarget: {title: string, message: string, channel: string} | null = null;
    
    if (salesFollowUpContent && typeof salesFollowUpContent === 'object' && salesFollowUpContent.channel) {
      const channel = salesFollowUpContent.channel;
      
      switch (channel) {
        case 'email':
          refinementTarget = {
            title: "Refined and compelling email subject line that increases open rates",
            message: "Enhanced email message with persuasive copy, clear value proposition, and strong call-to-action",
            channel: channel
          };
          break;
        case 'whatsapp':
          refinementTarget = {
            title: "Improved WhatsApp message with casual yet professional tone",
            message: "Refined WhatsApp content that feels personal, direct, and encourages immediate response",
            channel: channel
          };
          break;
        case 'notification':
          refinementTarget = {
            title: "Enhanced in-app notification that captures attention",
            message: "Optimized notification message that's concise, actionable, and drives user engagement",
            channel: channel
          };
          break;
        case 'web':
          refinementTarget = {
            title: "Polished web popup/banner headline that converts",
            message: "Compelling web message with persuasive copy that motivates visitors to take action",
            channel: channel
          };
          break;
        default:
          refinementTarget = {
            title: `Refined ${channel} headline with improved copy`,
            message: `Enhanced ${channel} message content with better persuasion and engagement`,
            channel: channel
          };
      }
    }
    
    console.log(`📋 PHASE 2: Refinement target configured for channel: ${refinementTarget?.channel || 'none'}`);
    
    const copywriterCommand = CommandFactory.createCommand({
      task: 'lead nurture copywriting',
      userId: userId,
      agentId: agentId,
      site_id: siteId,
      description: 'Polish and improve the follow-up content created by the sales team without changing the core strategy. Act as a writing coach to enhance clarity, flow, and persuasion while preserving the sales team approach, channel selection, and fundamental messaging. Focus on making the existing content more engaging and effective.',
      targets: [
        {
          deep_thinking: "Analyze the sales team's strategically selected follow-up content and identify specific areas for copywriting improvement. Focus on enhancing clarity, flow, and persuasion while respecting and preserving the core sales strategy, channel selection, and messaging approach."
        },
        {
          refined_content: refinementTarget
        }
      ],
      context: copywriterContext,
      supervisor: [
        {
          agent_role: 'creative_director',
          status: 'not_initialized'
        },
        {
          agent_role: 'sales_manager',
          status: 'not_initialized'
        }
      ]
    });
    
    console.log(`🏗️ PHASE 2: Command created, sending for processing...`);
    
    // Submit copywriter command
    const copywriterCommandId = await commandService.submitCommand(copywriterCommand);
    console.log(`✅ PHASE 2: Copywriter command created successfully with internal ID: ${copywriterCommandId}`);
    
    // Wait for copywriter command to complete
    console.log(`⏳ PHASE 2: Waiting for copywriter command completion...`);
    const result = await waitForCommandCompletion(copywriterCommandId);
    
    if (result && result.completed && result.command) {
      console.log(`✅ PHASE 2: Copywriter command completed successfully`);
      
      // Extract refined content from results
      let refinedContent = [];
      if (result.command.results && Array.isArray(result.command.results)) {
        for (const commandResult of result.command.results) {
          if (commandResult.refined_content && Array.isArray(commandResult.refined_content)) {
            refinedContent = commandResult.refined_content;
            break;
          }
        }
      }
      
      console.log(`📊 PHASE 2: Refined content extracted:`, JSON.stringify(refinedContent, null, 2));
      
      return {
        commandId: copywriterCommandId,
        dbUuid: result.dbUuid,
        command: result.command
      };
    } else {
      console.error(`❌ PHASE 2: Copywriter command did not complete correctly`);
      return null;
    }
  } catch (error: any) {
    console.error(`❌ PHASE 2: Error creating/executing copywriter command:`, error);
    return null;
  }
}

async function getAgentInfo(agentId: string): Promise<{ user_id: string; site_id?: string; tools?: any[]; activities?: any[] } | null> {
  try {
    if (!isValidUUID(agentId)) {
      console.error(`Invalid agent ID: ${agentId}`);
      return null;
    }
    
    console.log(`🔍 Getting agent information: ${agentId}`);
    
    // Query agent in database - Specify only the columns we need
    const { data, error } = await supabaseAdmin
      .from('agents')
      .select('id, user_id, site_id, configuration')
      .eq('id', agentId)
      .single();
    
    if (error) {
      console.error('Error getting agent information:', error);
      return null;
    }
    
    if (!data) {
      console.log(`⚠️ Agent not found with ID: ${agentId}`);
      return null;
    }
    
    // Parse configuration if it's a string
    let config = data.configuration;
    if (typeof config === 'string') {
      try {
        config = JSON.parse(config);
      } catch (e) {
        console.error('Error parsing agent configuration:', e);
        config = {};
      }
    }
    
    // Ensure config is an object
    config = config || {};
    
    return {
      user_id: data.user_id,
      site_id: data.site_id,
      tools: config.tools || [],
      activities: config.activities || []
    };
  } catch (error) {
    console.error('Error getting agent information:', error);
    return null;
  }
}



export async function POST(request: Request) {
  try {
    const body = await request.json();
    
    // Extract parameters from request
    const { 
      siteId, 
      leadId, 
      userId, 
      agent_id,
      followUpType,
      leadStage,
      previousInteractions,
      leadData,
      productInterest,
      followUpInterval
    } = body;
    
    // Validate required parameters
    if (!siteId) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'siteId is required' } },
        { status: 400 }
      );
    }
    
    if (!leadId) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'leadId is required' } },
        { status: 400 }
      );
    }
    
    // Search for active sales agent if agent_id is not provided
    let effectiveAgentId = agent_id;
    let agentInfo: any = null;
    let effectiveUserId = userId;
    
    if (!effectiveAgentId) {
      // Search for an active agent in database for the site
      const foundAgent = await findActiveSalesAgent(siteId);
      if (foundAgent) {
        effectiveAgentId = foundAgent.agentId;
        effectiveUserId = foundAgent.userId;
        console.log(`🤖 Using found sales agent: ${effectiveAgentId} (user_id: ${effectiveUserId})`);
      } else {
        console.log(`⚠️ No active agent found for site: ${siteId}`);
      }
    } else if (isValidUUID(effectiveAgentId)) {
      // If we already have a valid agentId, get its complete information
      agentInfo = await getAgentInfo(effectiveAgentId);
      if (agentInfo) {
        // If no userId was provided, use the agent's
        if (!effectiveUserId) {
          effectiveUserId = agentInfo.user_id;
        }
      } else {
        return NextResponse.json(
          { success: false, error: { code: 'AGENT_NOT_FOUND', message: 'The specified agent was not found' } },
          { status: 404 }
        );
      }
    }
    
    // If we still don't have a userId, error
    if (!effectiveUserId) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'userId is required and no active agent found for the site' } },
        { status: 400 }
      );
    }
    
    // Get lead information from database if not provided
    let effectiveLeadData = leadData;
    if (!effectiveLeadData || Object.keys(effectiveLeadData).length === 0) {
      const leadInfo = await getLeadInfo(leadId);
      if (leadInfo) {
        effectiveLeadData = leadInfo;
      }
    }
    
    // Get previous interactions if not provided
    let effectivePreviousInteractions = previousInteractions;
    if (!effectivePreviousInteractions || !Array.isArray(effectivePreviousInteractions) || effectivePreviousInteractions.length === 0) {
      const interactions = await getPreviousInteractions(leadId);
      if (interactions && interactions.length > 0) {
        effectivePreviousInteractions = interactions;
      }
    }
    
    // Prepare context for command
    let contextMessage = `Lead ID: ${leadId}\nSite ID: ${siteId}`;
    
    // Add lead information to context
    if (effectiveLeadData) {
      contextMessage += `\n\nLead Information:`;
      
      if (effectiveLeadData.name) contextMessage += `\nName: ${effectiveLeadData.name}`;
      if (effectiveLeadData.company) contextMessage += `\nCompany: ${safeStringify(effectiveLeadData.company)}`;
      if (effectiveLeadData.position) contextMessage += `\nPosition: ${effectiveLeadData.position}`;
      if (effectiveLeadData.email) contextMessage += `\nEmail: ${effectiveLeadData.email}`;
      if (effectiveLeadData.phone) contextMessage += `\nPhone: ${effectiveLeadData.phone}`;
      
      // If there are custom fields or additional information
      if (effectiveLeadData.pain_points) {
        if (Array.isArray(effectiveLeadData.pain_points)) {
          contextMessage += `\nPain Points: ${effectiveLeadData.pain_points.join(', ')}`;
        } else {
          contextMessage += `\nPain Points: ${effectiveLeadData.pain_points}`;
        }
      }
      
      if (effectiveLeadData.budget_range) {
        contextMessage += `\nBudget Range: ${effectiveLeadData.budget_range}`;
      }
      
      // Add site information if available
      if (effectiveLeadData.sites) {
        contextMessage += `\nSite: ${effectiveLeadData.sites.name} (${effectiveLeadData.sites.url})`;
      }
      
      // Add visitor information if available
      if (effectiveLeadData.visitors) {
        if (effectiveLeadData.visitors.user_agent) {
          contextMessage += `\nUser Agent: ${effectiveLeadData.visitors.user_agent}`;
        }
        // Note: Location information is now saved only in visitor_sessions
        // contextMessage += `\nLocation: ${effectiveLeadData.visitors.location}`;
      }
    }
    
    // Add previous interactions information to context
    if (effectivePreviousInteractions && effectivePreviousInteractions.length > 0) {
      contextMessage += `\n\nPrevious Interactions:`;
      
      effectivePreviousInteractions.forEach((interaction: any, index: number) => {
        contextMessage += `\n${index + 1}. Date: ${interaction.date || interaction.created_at}`;
        contextMessage += `\n   Type: ${interaction.type || 'Unknown'}`;
        contextMessage += `\n   Summary: ${interaction.summary || interaction.content || 'No summary available'}`;
        
        if (index < effectivePreviousInteractions.length - 1) {
          contextMessage += `\n`;
        }
      });
    }
    
    // Add product interest information
    if (productInterest && Array.isArray(productInterest) && productInterest.length > 0) {
      contextMessage += `\n\nProducts of Interest: ${productInterest.join(', ')}`;
    }
    
    // Add lead stage information
    if (leadStage) {
      contextMessage += `\n\nLead Stage: ${leadStage}`;
    }
    
    // Add requested follow-up type
    if (followUpType) {
      contextMessage += `\n\nRequested Follow-up Type: ${followUpType}`;
    }
    
    // Add requested follow-up interval
    if (followUpInterval) {
      contextMessage += `\n\nRequested Follow-up Interval: ${followUpInterval}`;
    }
    
    // Add enriched context with content, tasks and conversations
    console.log(`🔍 Building enriched context for command...`);
    const enrichedContext = await buildEnrichedContext(siteId, leadId);
    if (enrichedContext) {
      contextMessage += `\n\n${enrichedContext}`;
      console.log(`✅ Enriched context added (${enrichedContext.length} characters)`);
    } else {
      console.log(`⚠️ Could not get enriched context`);
    }
    
    // Add copywriting guidelines
    contextMessage += `\n\n=== COPYWRITING GUIDELINES ===\n`;
    contextMessage += `🎯 IMPORTANT: If there are approved copywritings available for this lead or campaign, respect them as much as possible.\n`;
    contextMessage += `- Only personalize approved copywritings with lead-specific information to increase conversion\n`;
    contextMessage += `- Maintain the core message, tone, and structure of approved content\n`;
    contextMessage += `- Use lead data (name, company, pain points, etc.) to customize approved messages\n`;
    contextMessage += `- Focus on lead-specific personalization rather than completely rewriting approved content\n`;
    contextMessage += `🌍 LANGUAGE & ACCENT GUIDELINES:\n`;
    contextMessage += `- Analyze the prospect's information (name, company, location, user agent, etc.) to determine their most likely language and accent\n`;
    contextMessage += `- Send messages in the language and accent most probable for the prospect based on their profile and context\n`;
    contextMessage += `- Consider cultural nuances and communication preferences when selecting language and tone\n`;
    contextMessage += `- Adapt the message style to match the prospect's likely cultural and linguistic background\n`;
    contextMessage += `=== END OF COPYWRITING GUIDELINES ===\n`;
    

    // Determine which communication channels are available
    const hasEmail = effectiveLeadData && effectiveLeadData.email && effectiveLeadData.email.trim() !== '';
    const hasPhone = effectiveLeadData && effectiveLeadData.phone && effectiveLeadData.phone.trim() !== '';
    
    console.log(`📞 Available channels - Email: ${hasEmail ? 'YES' : 'NO'}, Phone: ${hasPhone ? 'YES' : 'NO'}`);
    
    // Build available channels list for context
    const availableChannels = [];
    
    if (hasEmail) {
      availableChannels.push('email');
    }
    if (hasPhone) {
      availableChannels.push('whatsapp');
    }
    // Always add web and notification channels (don't depend on specific lead data)
    availableChannels.push('notification', 'web');
    
    console.log(`📋 Available channels for context: ${availableChannels.join(', ')}`);

    // Add specific instructions about channel selection to context
    contextMessage += `\n\n=== AVAILABLE COMMUNICATION CHANNELS ===\n`;
    contextMessage += `The following channels are available for this lead:\n`;
    
    if (availableChannels.includes('email')) {
      contextMessage += `• EMAIL: Professional communication, detailed information, document attachments\n`;
    }
    if (availableChannels.includes('whatsapp')) {
      contextMessage += `• WHATSAPP: Immediate communication, casual messaging, mobile-first leads\n`;
    }
    contextMessage += `• NOTIFICATION: In-app notifications for active platform users, short messages\n`;
    contextMessage += `• WEB: Website popups/banners for visitors, offers and demos\n`;
    
    contextMessage += `\n=== CRITICAL INSTRUCTIONS FOR CHANNEL SELECTION ===\n`;
    contextMessage += `🚨 FUNDAMENTAL RULE: ONLY CONTACT THROUGH ONE CHANNEL AT A TIME 🚨\n`;
    contextMessage += `- NEVER use multiple channels simultaneously\n`;
    contextMessage += `- A lead should receive communication through only one channel per interaction\n`;
    contextMessage += `- Contacting through multiple channels creates annoyance and may push prospects away\n`;
    contextMessage += `- Choose the channel MOST LIKELY to generate a positive response\n`;
    contextMessage += `\n⚠️ IMPORTANT: You MUST select and return content for ONLY ONE CHANNEL.\n`;
    contextMessage += `⚠️ Base your decision on the lead's history, context, and profile shown above.\n`;
    contextMessage += `=== END OF INSTRUCTIONS ===\n\n`;

    // PHASE 1: Create command for Sales/CRM Specialist
    console.log(`🚀 PHASE 1: Creating command for Sales/CRM Specialist`);
    const salesCommand = CommandFactory.createCommand({
      task: 'lead follow-up strategy',
      userId: effectiveUserId,
      agentId: effectiveAgentId,
      site_id: siteId,
      description: 'Generate a personalized follow-up message for a qualified lead, focusing on addressing their pain points and interests, with appropriate timing between touchpoints. You want to delight and nurture the lead. IMPORTANT: Based on the lead\'s history, profile and context, select ONLY the most effective channel to avoid harassing the user. You must choose only 1 channel from the available ones, the one with the highest probability of success according to the lead\'s context.',
      targets: [
        {
          deep_thinking: "Analyze the lead information, their interaction history, preferences, and profile to determine the single most effective communication channel. Consider factors like: lead's communication preferences, previous interactions, urgency level, lead stage, and professional context. Choose only ONE channel to avoid overwhelming the lead."
        },
        {
          follow_up_content: {
            strategy: "comprehensive sale strategy based on lead analysis",
            title: "compelling title or subject line for the selected channel",
            message: "personalized message content optimized for the chosen channel",
            channel: "the single most effective channel selected (email/whatsapp/notification/web)"
          }
        }
      ],
      context: contextMessage,
      supervisor: [
        {
          agent_role: 'sales_manager',
          status: 'not_initialized'
        },
        {
          agent_role: 'customer_success',
          status: 'not_initialized'
        }
      ]
    });
    
    // Submit command for asynchronous processing
    const salesCommandId = await commandService.submitCommand(salesCommand);
    console.log(`📝 PHASE 1: Sales command created with internal ID: ${salesCommandId}`);
    
    // Wait for sales command to complete
    console.log(`⏳ PHASE 1: Waiting for sales command completion...`);
    const { command: completedSalesCommand, dbUuid: salesDbUuid, completed: salesCompleted } = await waitForCommandCompletion(salesCommandId);
    
    if (!salesCompleted || !completedSalesCommand) {
      console.error(`❌ PHASE 1: Sales command did not complete correctly`);
      
      // Provide more detailed error information
      const errorDetails = {
        commandId: salesCommandId,
        completed: salesCompleted,
        hasCommand: !!completedSalesCommand,
        commandStatus: completedSalesCommand?.status || 'unknown',
        hasResults: !!(completedSalesCommand?.results && completedSalesCommand.results.length > 0)
      };
      
      console.error(`❌ PHASE 1: Error details:`, errorDetails);
      
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'SALES_COMMAND_FAILED', 
            message: 'Sales command did not complete successfully',
            details: errorDetails
          } 
        },
        { status: 500 }
      );
    }
    
    // Log completion status with more detail
    if (completedSalesCommand.status === 'completed') {
      console.log(`✅ PHASE 1: Sales command completed successfully`);
    } else if (completedSalesCommand.status === 'failed') {
      console.log(`⚠️ PHASE 1: Sales command failed but has recoverable results`);
      console.log(`🔄 PHASE 1: Error was handled gracefully, proceeding with available results`);
    }
    
    console.log(`📊 PHASE 1: Results obtained:`, JSON.stringify(completedSalesCommand.results, null, 2));
    
    // Extract follow-up content from results
    let salesFollowUpContent = null;
    if (completedSalesCommand.results && Array.isArray(completedSalesCommand.results)) {
      console.log(`🔍 PHASE 1: Complete results structure:`, JSON.stringify(completedSalesCommand.results, null, 2));
      
      for (const result of completedSalesCommand.results) {
        console.log(`🔍 PHASE 1: Analyzing result:`, Object.keys(result));
        
        // Search for follow_up_content (now expecting object, not array)
        if (result.follow_up_content && typeof result.follow_up_content === 'object' && !Array.isArray(result.follow_up_content)) {
          salesFollowUpContent = result.follow_up_content;
          console.log(`✅ PHASE 1: Found follow_up_content object`);
          break;
        }
        
        // Search for other possible structures
        if (result.content && typeof result.content === 'object' && !Array.isArray(result.content)) {
          salesFollowUpContent = result.content;
          console.log(`✅ PHASE 1: Found content object`);
          break;
        }
        
        // Legacy support for array format (convert first element)
        if (result.follow_up_content && Array.isArray(result.follow_up_content) && result.follow_up_content.length > 0) {
          salesFollowUpContent = result.follow_up_content[0];
          console.log(`✅ PHASE 1: Found follow_up_content array, using first element`);
          break;
        }
      }
    }
    
    console.log(`📊 PHASE 1: Follow-up content extracted:`, JSON.stringify(salesFollowUpContent, null, 2));
    
    // Verify if we have valid content
    if (!salesFollowUpContent || typeof salesFollowUpContent !== 'object') {
      console.error(`❌ PHASE 1: Could not extract follow-up content from results`);
      console.log(`🔍 PHASE 1: Available results structure:`, JSON.stringify(completedSalesCommand.results, null, 2));
      
      // If the command failed due to timeout but we need to continue, create a fallback response
      if (completedSalesCommand.status === 'failed') {
        console.log(`🔄 PHASE 1: Command failed, checking if we can create fallback content...`);
        
        // Check if we have error information that might be useful
        const errorResult = completedSalesCommand.results?.find((r: any) => r.error || r.error_type);
        if (errorResult) {
          console.log(`⚠️ PHASE 1: Creating fallback response due to: ${errorResult.error_type || 'unknown error'}`);
          
          // Create a basic fallback content structure
          salesFollowUpContent = {
            strategy: "Follow-up strategy (generated after processing timeout)",
            title: "Personalized Follow-up",
            message: "Thank you for your interest. We'd like to follow up on your inquiry and provide you with more information that might be helpful.",
            channel: "email", // Default to email as safest option
            _metadata: {
              fallback: true,
              original_error: errorResult.error_type,
              generated_at: new Date().toISOString()
            }
          };
          
          console.log(`🔧 PHASE 1: Fallback content created:`, JSON.stringify(salesFollowUpContent, null, 2));
        }
      }
    }
    
    // PHASE 2: Search for copywriter and create second command
    console.log(`🚀 PHASE 2: Starting copywriter search for site: ${siteId}`);
    
    // Search for active copywriter
    const copywriterAgent = await findActiveCopywriter(siteId);
    let copywriterAgentId: string | null = null;
    let copywriterUserId = effectiveUserId; // Fallback to original userId
    let shouldExecutePhase2 = false;
    
    if (copywriterAgent) {
      copywriterAgentId = copywriterAgent.agentId;
      copywriterUserId = copywriterAgent.userId;
      shouldExecutePhase2 = true;
      console.log(`🤖 PHASE 2: Copywriter found successfully: ${copywriterAgentId} (user_id: ${copywriterUserId})`);
    } else {
      console.log(`⚠️ PHASE 2: No active copywriter found for site: ${siteId}`);
      console.log(`⚠️ PHASE 2: Skipping second phase - will only execute sales phase`);
    }
    
    // Variables for phase 2
    let copywriterCommandId: string | null = null;
    let copywriterDbUuid: string | null = null;
    let completedCopywriterCommand: any = null;
    let copywriterCompleted = false;
    
    // Only execute phase 2 if copywriter is available AND sales content exists
    if (shouldExecutePhase2 && copywriterAgentId && typeof copywriterAgentId === 'string' && salesFollowUpContent && typeof salesFollowUpContent === 'object') {
      console.log(`🚀 PHASE 2: Executing copywriter phase...`);
      
      // Execute helper function for copywriter
      const copywriterResult = await executeCopywriterRefinement(
        siteId,
        copywriterAgentId,
        copywriterUserId,
        contextMessage,
        salesFollowUpContent, // Pass extracted content instead of complete command
        leadId
      );
      
      if (copywriterResult) {
        copywriterCommandId = copywriterResult.commandId;
        copywriterDbUuid = copywriterResult.dbUuid;
        completedCopywriterCommand = copywriterResult.command;
        copywriterCompleted = true;
        console.log(`✅ PHASE 2: Copywriter command completed successfully`);
      } else {
        console.error(`❌ PHASE 2: Copywriter command did not complete correctly`);
      }
    } else {
      if (!shouldExecutePhase2) {
        console.log(`⏭️ PHASE 2: Skipping copywriter phase - no agent available`);
      } else if (!copywriterAgentId) {
        console.log(`⏭️ PHASE 2: Skipping copywriter phase - agentId is null`);
      } else if (!salesFollowUpContent || typeof salesFollowUpContent !== 'object') {
        console.log(`⏭️ PHASE 2: Skipping copywriter phase - no sales content to refine`);
      } else {
        console.log(`⏭️ PHASE 2: Skipping copywriter phase - condition not met`);
      }
    }
    
    // Extract messages from final result (prioritize copywriter if exists)
    const finalCommand = copywriterCompleted ? completedCopywriterCommand : completedSalesCommand;
    let finalContent = [];
    
    console.log(`📊 FINAL EXTRACTION: Using ${copywriterCompleted ? 'COPYWRITER' : 'SALES'} command for final content`);
    console.log(`📊 FINAL EXTRACTION: salesFollowUpContent available:`, !!salesFollowUpContent);
    console.log(`📊 FINAL EXTRACTION: salesFollowUpContent:`, JSON.stringify(salesFollowUpContent, null, 2));
    console.log(`📊 FINAL EXTRACTION: finalCommand exists:`, !!finalCommand);
    console.log(`📊 FINAL EXTRACTION: finalCommand.results exists:`, !!(finalCommand && finalCommand.results));
    console.log(`📊 FINAL EXTRACTION: finalCommand.results is array:`, !!(finalCommand && finalCommand.results && Array.isArray(finalCommand.results)));
    
    // Extract content from final command
    if (finalCommand && finalCommand.results && Array.isArray(finalCommand.results)) {
      console.log(`📊 FINAL EXTRACTION: Processing ${finalCommand.results.length} results`);
      
      for (const result of finalCommand.results) {
        console.log(`📊 FINAL EXTRACTION: Processing result with keys:`, Object.keys(result));
        
        // For copywriter, search for refined_content (can be object or array)
        if (copywriterCompleted && result.refined_content) {
          console.log(`📊 FINAL EXTRACTION: Found refined_content (copywriter mode)`);
          if (Array.isArray(result.refined_content)) {
            finalContent = result.refined_content;
            console.log(`📊 FINAL EXTRACTION: Using refined_content array with ${finalContent.length} items`);
          } else if (typeof result.refined_content === 'object') {
            finalContent = [result.refined_content]; // Convert object to array
            console.log(`📊 FINAL EXTRACTION: Converted refined_content object to array`);
          }
          break;
        }
        // For sales, search for follow_up_content (can be object or array)
        else if (!copywriterCompleted && result.follow_up_content) {
          console.log(`📊 FINAL EXTRACTION: Found follow_up_content (sales mode)`);
          console.log(`📊 FINAL EXTRACTION: follow_up_content type:`, typeof result.follow_up_content);
          console.log(`📊 FINAL EXTRACTION: follow_up_content is array:`, Array.isArray(result.follow_up_content));
          console.log(`📊 FINAL EXTRACTION: follow_up_content content:`, JSON.stringify(result.follow_up_content, null, 2));
          
          if (Array.isArray(result.follow_up_content)) {
            finalContent = result.follow_up_content;
            console.log(`📊 FINAL EXTRACTION: Using follow_up_content array with ${finalContent.length} items`);
          } else if (typeof result.follow_up_content === 'object') {
            finalContent = [result.follow_up_content]; // Convert object to array
            console.log(`📊 FINAL EXTRACTION: Converted follow_up_content object to array`);
            console.log(`📊 FINAL EXTRACTION: finalContent after conversion:`, JSON.stringify(finalContent, null, 2));
          }
          break;
        }
        // Fallbacks
        else if (result.content && Array.isArray(result.content)) {
          console.log(`📊 FINAL EXTRACTION: Using fallback content array`);
          finalContent = result.content;
          break;
        }
        else if (result.content && typeof result.content === 'object') {
          console.log(`📊 FINAL EXTRACTION: Using fallback content object`);
          finalContent = [result.content]; // Convert object to array
          break;
        }
        else if (Array.isArray(result)) {
          console.log(`📊 FINAL EXTRACTION: Using result as array`);
          finalContent = result;
          break;
        }
        else {
          console.log(`📊 FINAL EXTRACTION: No matching content found in this result`);
        }
      }
    } else {
      console.error(`❌ FINAL EXTRACTION: Could not access finalCommand.results`);
    }
    
    console.log(`📊 FINAL EXTRACTION: Final finalContent:`, JSON.stringify(finalContent, null, 2));
    console.log(`📊 FINAL EXTRACTION: finalContent length:`, finalContent.length);
    
    // 🔧 FALLBACK: Si finalContent está vacío pero tenemos salesFollowUpContent, usarlo
    if ((!finalContent || finalContent.length === 0) && salesFollowUpContent && typeof salesFollowUpContent === 'object') {
      console.log(`🔄 FALLBACK: finalContent is empty, using salesFollowUpContent as fallback`);
      console.log(`🔄 FALLBACK: salesFollowUpContent:`, JSON.stringify(salesFollowUpContent, null, 2));
      finalContent = [salesFollowUpContent];
      console.log(`✅ FALLBACK: Set finalContent from salesFollowUpContent`);
    }
    
    // Organize messages by channel
    const messages: any = {};
    
    console.log(`🏗️ MESSAGE STRUCTURING: Starting with finalContent length: ${finalContent.length}`);
    
    if (finalContent && Array.isArray(finalContent)) {
      finalContent.forEach((item: any, index: number) => {
        console.log(`🏗️ MESSAGE STRUCTURING: Processing item ${index}:`, JSON.stringify(item, null, 2));
        console.log(`🏗️ MESSAGE STRUCTURING: Item has channel:`, !!item.channel);
        console.log(`🏗️ MESSAGE STRUCTURING: Item channel value:`, item.channel);
        
        if (item.channel) {
          messages[item.channel] = {
            title: item.title || '',
            message: item.message || '',
            strategy: item.strategy || ''
          };
          console.log(`✅ MESSAGE STRUCTURING: Added message for channel ${item.channel}`);
        } else {
          console.log(`⚠️ MESSAGE STRUCTURING: Item ${index} has no channel property`);
        }
      });
    } else {
      console.error(`❌ MESSAGE STRUCTURING: finalContent is not a valid array`);
      console.log(`❌ MESSAGE STRUCTURING: finalContent type:`, typeof finalContent);
      console.log(`❌ MESSAGE STRUCTURING: finalContent is array:`, Array.isArray(finalContent));
    }
    
    console.log(`🚀 Sequence completed - Sales: ${salesCompleted ? 'SUCCESS' : 'FAILED'}, Copywriter: ${copywriterCompleted ? 'SUCCESS' : 'FAILED'}`);
    console.log(`📦 Messages structured by channel:`, Object.keys(messages));
    console.log(`📦 Messages content:`, JSON.stringify(messages, null, 2));
    
    // ===== MANUAL CHANNEL FILTERING =====
    console.log(`🔧 STARTING MANUAL CHANNEL FILTERING FOR SITE: ${siteId}`);
    
    // Get site channel configuration
    const channelConfig = await getSiteChannelsConfiguration(siteId);
    console.log(`📡 Channel configuration result:`, channelConfig);
    
    // Check if site has no channels configured at all
    if (!channelConfig.hasChannels) {
      console.error(`❌ CHANNEL FILTER ERROR: Site ${siteId} has no channels configured`);
      
      // Trigger channels setup notification to alert team members
      console.log(`📧 TRIGGERING CHANNELS SETUP NOTIFICATION for site: ${siteId}`);
      try {
        await triggerChannelsSetupNotification(siteId);
        console.log(`✅ Channels setup notification triggered successfully`);
      } catch (notificationError) {
        console.error(`⚠️ Failed to trigger channels setup notification, but continuing with error response:`, notificationError);
      }
      
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'NO_CHANNELS_CONFIGURED', 
            message: 'Site has no communication channels configured. Please configure at least email or WhatsApp channels in site settings before sending messages. Team members have been notified to set up channels.',
            details: channelConfig.warning,
            action_taken: 'Channels setup notification sent to team members'
          } 
        },
        { status: 400 }
      );
    }
    
    // Apply manual channel filtering
    const { correctedMessages, corrections } = filterAndCorrectMessageChannel(
      messages, 
      channelConfig.configuredChannels
    );
    
    // Check if no messages remain after filtering
    if (Object.keys(correctedMessages).length === 0) {
      console.error(`❌ CHANNEL FILTER ERROR: No valid messages remain after channel filtering`);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'NO_VALID_CHANNELS', 
            message: 'No valid communication channels available for this message. The generated message channels are not configured for this site.',
            details: {
              available_channels: channelConfig.configuredChannels,
              original_channels: Object.keys(messages),
              corrections_applied: corrections
            }
          } 
        },
        { status: 400 }
      );
    }
    
    console.log(`✅ CHANNEL FILTERING COMPLETED`);
    console.log(`📋 Final messages after filtering:`, Object.keys(correctedMessages));
    if (corrections.length > 0) {
      console.log(`🔄 Channel corrections applied:`, corrections);
    }
    
    // ===== END MANUAL CHANNEL FILTERING =====
    
    // 🔧 CORRECCIÓN: Usar UUIDs de la base de datos en lugar de IDs internos
    const finalCommandIds = {
      sales: salesDbUuid || salesCommandId, // Priorizar UUID de DB
      copywriter: copywriterDbUuid || copywriterCommandId // Priorizar UUID de DB
    };
    
    console.log(`🔑 Final command IDs to return:`, {
      sales: finalCommandIds.sales + (salesDbUuid ? ' (DB UUID)' : ' (internal ID)'),
      copywriter: finalCommandIds.copywriter + (copywriterDbUuid ? ' (DB UUID)' : ' (internal ID)')
    });
    
    const responseData: any = {
      messages: correctedMessages, // Return filtered messages instead of original
      lead: effectiveLeadData || {},
      command_ids: finalCommandIds
    };
    
    // Add channel corrections if any were applied
    if (corrections.length > 0) {
      responseData.channel_corrections = {
        applied: corrections,
        configured_channels: channelConfig.configuredChannels,
        original_channels: Object.keys(messages)
      };
    }
    
    return NextResponse.json({
      success: true,
      data: responseData
    });
    
  } catch (error) {
    console.error('General error in lead follow-up route:', error);
    
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'SYSTEM_ERROR', 
          message: 'An internal system error occurred' 
        } 
      },
      { status: 500 }
    );
  }
} 