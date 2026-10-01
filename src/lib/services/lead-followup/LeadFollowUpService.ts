import { createLeadFollowUpSalesCommand } from './LeadFollowUpSalesCommand';
import { isOutreachActivity } from '@/lib/services/outreach/policy';
import { assertOutreachGeneration } from '@/lib/services/outreach/generation-guard';
import { 
  getLeadInfo, 
  getPreviousInteractions, 
  buildEnrichedContext
} from '@/lib/helpers/lead-context-helper';
import {
  parseIncomingRequest,
  isValidUUID,
  isValidPhoneNumber,
  findActiveSalesAgent,
  findActiveCopywriter,
  getSiteChannelsConfiguration,
  triggerChannelsSetupNotification,
  filterAndCorrectMessageChannel,
  waitForCommandCompletion,
  executeCopywriterRefinement,
  getAgentInfo,
  commandService
} from '@/lib/services/lead-followup/LeadFollowUpHelper';
import { LeadContextBuilder } from '@/lib/services/lead-followup/LeadContextBuilder';
import {
  validateToolExecutionResults,
  extractSalesFollowUpContent,
  createFallbackContent,
  extractFinalContent,
  organizeMessagesByChannel,
  buildDiagnosticInfo,
  buildToolExecutionMetadata
} from '@/lib/services/lead-followup/helpers/LeadFollowUpContentHelper';

export class LeadFollowUpService {
  
  async processRequest(request: Request, requestId: string): Promise<any> {
    console.log(`[LeadFollowUp:${requestId}] ▶️ Incoming request`);
    const { body: rawBody, files } = await parseIncomingRequest(request, requestId);
    // Normalize keys to camelCase aliases
    const body: any = {
      ...rawBody,
      siteId: rawBody?.siteId || rawBody?.site_id,
      leadId: rawBody?.leadId || rawBody?.lead_id,
      userId: rawBody?.userId || rawBody?.user_id,
      agent_id: rawBody?.agent_id || rawBody?.agentId,
      visitorId: rawBody?.visitorId || rawBody?.visitor_id
    };
    
    console.log(`[LeadFollowUp:${requestId}] CP1b normalized fields:`, {
      siteId: body.siteId,
      leadId: body.leadId,
      userId: body.userId,
      agent_id: body.agent_id,
      visitorId: body.visitorId,
      hasFiles: Object.keys(files || {}).length > 0
    });
    
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
      followUpInterval,
      phone_number
    } = body;
    
    // Validate required parameters
    if (!siteId) {
      throw { code: 'INVALID_REQUEST', message: 'siteId is required', status: 400 };
    }
    
    if (!leadId) {
      throw { code: 'INVALID_REQUEST', message: 'leadId is required', status: 400 };
    }

    // Strong UUID validation with clear early errors
    if (!isValidUUID(siteId)) {
      console.error(`[LeadFollowUp:${requestId}] INVALID siteId UUID: ${siteId}`);
      throw { code: 'INVALID_INPUT', message: 'siteId must be a valid UUID', status: 400 };
    }
    if (!isValidUUID(leadId)) {
      console.error(`[LeadFollowUp:${requestId}] INVALID leadId UUID: ${leadId}`);
      throw { code: 'INVALID_INPUT', message: 'leadId must be a valid UUID', status: 400 };
    }
    
    // Validate phone_number if provided (prevent empty strings and invalid formats)
    if (phone_number !== undefined && !isValidPhoneNumber(phone_number)) {
      console.error(`[LeadFollowUp:${requestId}] ❌ INVALID phone_number: "${phone_number}" (length: ${phone_number?.length || 0})`);
      console.log(`[LeadFollowUp:${requestId}] 📱 Phone validation failed - rejecting request to prevent empty/invalid WhatsApp attempts`);
      throw { 
        code: 'INVALID_PHONE_NUMBER', 
        message: 'phone_number must be a valid phone number with at least 7 digits. Empty strings are not allowed.', 
        status: 400 
      };
    }
    
    const outreachActivity = body.outreach_activity ?? body.additionalData?.outreach_activity;
    if (outreachActivity !== undefined && !isOutreachActivity(outreachActivity)) {
      throw { code: 'INVALID_OUTREACH_ACTIVITY', message: 'Invalid outreach_activity', status: 400 };
    }
    const managed = outreachActivity
      ? await assertOutreachGeneration(request, siteId, leadId, outreachActivity) : undefined;
    const managedLead = managed?.lead;

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
        throw { code: 'AGENT_NOT_FOUND', message: 'The specified agent was not found', status: 404 };
      }
    }
    
    if (!effectiveUserId) {
      throw { code: 'INVALID_REQUEST', message: 'userId is required', status: 400 };
    }
    
    // Get lead information from database if not provided
    let effectiveLeadData = managedLead || leadData;
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

    // Determine lead contact availability
    const hasEmail = !!(effectiveLeadData && effectiveLeadData.email && String(effectiveLeadData.email).trim() !== '');
    const hasPhone = !!(effectiveLeadData && effectiveLeadData.phone && String(effectiveLeadData.phone).trim() !== '');

    // Fetch site channel configuration EARLY (before any AI work)
    const channelConfig = await getSiteChannelsConfiguration(siteId, outreachActivity);
    console.log(`[LeadFollowUp:${requestId}] 📡 [EARLY] Channel configuration result:`, channelConfig);

    // Early abort if site has no channels configured
    if (!channelConfig.hasChannels) {
      console.error(`❌ CHANNELS CONFIG: Site ${siteId} has no channels configured. Aborting before AI.`);
      try {
        if (!outreachActivity) await triggerChannelsSetupNotification(siteId);
      } catch (notificationError) {
        console.error(`⚠️ Failed to trigger channels setup notification:`, notificationError);
      }
      throw {
        code: 'NO_CHANNELS_CONFIGURED',
        message: 'Site has no communication channels configured. Select a connected outreach account in settings before sending messages.',
        details: channelConfig.warning || 'No channels configured',
        action_taken: 'Channels setup notification attempted',
        status: 400
      };
    }

    // Early abort if no configured channel matches lead contact data
    const recipientChannels = managed?.channels || channelConfig.configuredChannels.filter(channel =>
      (channel === 'email' && hasEmail) || (channel === 'whatsapp' && hasPhone));
    if (!recipientChannels.length) {
      console.error(`❌ CHANNELS CONFIG: No valid channel for this lead. Aborting before AI.`, {
        configured: channelConfig.configuredChannels,
        hasEmail,
        hasPhone
      });
      throw {
        code: 'NO_VALID_CHANNELS_FOR_LEAD',
        message: 'No valid configured channel matches this lead contact info.',
        details: {
          configured_channels: channelConfig.configuredChannels,
          lead_has_email: hasEmail,
          lead_has_phone: hasPhone
        },
        status: 400
      };
    }
    
    // Prepare context for command using LeadContextBuilder
    let contextMessage = LeadContextBuilder.buildContextMessage(
        leadId, 
        siteId, 
        effectiveLeadData, 
        effectivePreviousInteractions, 
        productInterest, 
        leadStage, 
        followUpType, 
        followUpInterval
    );
    
    // Add enriched context with content, tasks and conversations
    console.log(`🔍 Building enriched context for command...`);
    const enrichedContext = await buildEnrichedContext(siteId, leadId);
    if (enrichedContext) {
      contextMessage += `\n\n${enrichedContext}`;
      console.log(`✅ Enriched context added (${enrichedContext.length} characters)`);
    } else {
      console.log(`⚠️ Could not get enriched context`);
    }
    
    contextMessage += LeadContextBuilder.getConversationIntelligenceInstructions();
    contextMessage += LeadContextBuilder.getCopywritingGuidelines();
    contextMessage += LeadContextBuilder.getLeadQualificationPolicy();

    // Determine which communication channels are available (consider site config)
    console.log(`[LeadFollowUp:${requestId}] 📞 Lead contact availability - Email: ${hasEmail ? 'YES' : 'NO'}, Phone: ${hasPhone ? 'YES' : 'NO'}`);
    
    // Build available channels list for context
    const availableChannels = [...recipientChannels];
    // Always add web and notification channels (don't depend on specific lead data)
    if (!outreachActivity) availableChannels.push('notification', 'web');
    
    console.log(`📋 Available channels for context: ${availableChannels.join(', ')}`);

    // Add specific instructions about channel selection to context
    contextMessage += LeadContextBuilder.getChannelSelectionInstructions(availableChannels);
    if (managed) contextMessage += '\nThese channels have server-validated recipients. Do not invent contact identities or switch to an unavailable channel. For voice, generate a spoken greeting of 1–1000 characters; this starts a tracked call subject to explicit call opt-outs, not a text message.';

    // PHASE 1: Create command for Sales/CRM Specialist
    console.log(`🚀 PHASE 1: Creating command for Sales/CRM Specialist`);
    const salesCommand = createLeadFollowUpSalesCommand({
      siteId,
      userId: effectiveUserId,
      agentId: effectiveAgentId,
      availableChannels,
      context: contextMessage,
    });
    
    // Submit command for asynchronous processing
    const salesCommandId = await commandService.submitCommand(salesCommand);
    console.log(`📝 PHASE 1: Sales command created with internal ID: ${salesCommandId}`);
    
    // Wait for sales command to complete
    console.log(`⏳ PHASE 1: Waiting for sales command completion...`);
    const { command: completedSalesCommand, dbUuid: salesDbUuid, completed: salesCompleted } = await waitForCommandCompletion(salesCommandId);
    
    // Check for tool execution failures - these are non-fatal, continue processing
    const toolExecutionFailed = completedSalesCommand?.tool_execution_failed || false;
    const toolExecutionError = completedSalesCommand?.tool_execution_error || null;
    
    if (toolExecutionFailed) {
      console.warn(`⚠️ PHASE 1: Tool execution failed but command continued:`, toolExecutionError);
      console.warn(`⚠️ PHASE 1: This is non-fatal - continuing with available results`);
    }
    
    // Validate tool execution results if they exist
    if (completedSalesCommand?.functions && Array.isArray(completedSalesCommand.functions)) {
        validateToolExecutionResults(completedSalesCommand.functions);
    }
    
    // Update completion check logic: allow processing even if status is 'failed' but results are available
    const hasValidResults = completedSalesCommand?.results && Array.isArray(completedSalesCommand.results) && completedSalesCommand.results.length > 0;
    
    if (!completedSalesCommand || (!salesCompleted && !hasValidResults)) {
      console.error(`❌ PHASE 1: Sales command did not complete correctly and has no recoverable results`);
      
      const errorDetails = {
        commandId: salesCommandId,
        completed: salesCompleted,
        hasCommand: !!completedSalesCommand,
        commandStatus: completedSalesCommand?.status || 'unknown',
        hasResults: hasValidResults
      };
      
      console.error(`❌ PHASE 1: Error details:`, errorDetails);
      
      throw { 
        code: 'SALES_COMMAND_FAILED', 
        message: 'Sales command did not complete successfully and has no recoverable results',
        details: errorDetails,
        tool_execution_error: toolExecutionError,
        status: 500
      };
    }
    
    // Log if we're processing results even though command failed
    if (completedSalesCommand.status === 'failed' && hasValidResults) {
      console.warn(`⚠️ PHASE 1: Sales command failed but has recoverable results - processing anyway`);
    }
    
    // Extract follow-up content from results
    let salesFollowUpContent = extractSalesFollowUpContent(completedSalesCommand, requestId);
    
    // Verify if we have valid content
    if (!salesFollowUpContent || typeof salesFollowUpContent !== 'object') {
      console.error(`❌ PHASE 1: Could not extract follow-up content from results`);
      
      // If the command failed, try to create fallback content
      if (completedSalesCommand.status === 'failed' || !salesCompleted) {
        salesFollowUpContent = createFallbackContent(completedSalesCommand, availableChannels);
      }
    }
    
    // PHASE 2: Search for copywriter and create second command
    // Search for active copywriter
    const copywriterAgent = await findActiveCopywriter(siteId);
    let copywriterAgentId: string | null = null;
    let copywriterUserId = effectiveUserId; // Fallback to original userId
    let shouldExecutePhase2 = false;
    
    if (copywriterAgent) {
      copywriterAgentId = copywriterAgent.agentId;
      copywriterUserId = copywriterAgent.userId;
      shouldExecutePhase2 = true;
    }
    
    // Variables for phase 2
    let copywriterCommandId: string | null = null;
    let copywriterDbUuid: string | null = null;
    let completedCopywriterCommand: any = null;
    let copywriterCompleted = false;
    
    // Only execute phase 2 if copywriter is available AND sales content exists
    if (shouldExecutePhase2 && copywriterAgentId && typeof copywriterAgentId === 'string' && salesFollowUpContent && typeof salesFollowUpContent === 'object') {
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
      } else {
        console.error(`❌ PHASE 2: Copywriter command did not complete correctly`);
      }
    }
    
    // Extract messages from final result (prioritize copywriter if exists)
    const finalCommand = copywriterCompleted ? completedCopywriterCommand : completedSalesCommand;
    let finalContent = extractFinalContent(finalCommand, copywriterCompleted, salesFollowUpContent, requestId, availableChannels, !!managed);
    
    // Organize messages by channel
    const messages: any = organizeMessagesByChannel(finalContent, hasEmail, hasPhone, channelConfig, requestId);
    
    console.log(`[LeadFollowUp:${requestId}] 📨 Messages organized:`, {
      channels: Object.keys(messages),
      count: Object.keys(messages).length
    });
    
    // ===== MANUAL CHANNEL FILTERING =====
    console.log(`🔧 STARTING MANUAL CHANNEL FILTERING FOR SITE: ${siteId}`);
    
    // Check if site has no channels configured at all
    if (!channelConfig.hasChannels) {
      console.error(`❌ CHANNEL FILTER ERROR: Site ${siteId} has no channels configured`);
      
      try {
        await triggerChannelsSetupNotification(siteId);
      } catch (notificationError) {
        console.error(`⚠️ Failed to trigger channels setup notification, but continuing with error response:`, notificationError);
      }
      
      throw { 
        code: 'NO_CHANNELS_CONFIGURED', 
        message: 'Site has no communication channels configured. Please configure a connected outreach account in site settings before sending messages.',
        details: channelConfig.warning,
        action_taken: 'Channels setup notification sent to team members',
        status: 400
      };
    }
    
    // Apply manual channel filtering
    const { correctedMessages, corrections } = filterAndCorrectMessageChannel(
      messages,
      channelConfig.configuredChannels,
      {
        hasEmail,
        hasPhone,
        leadEmail: effectiveLeadData?.email || null,
        leadPhone: effectiveLeadData?.phone || null,
        ...(managed ? { recipients: managed.recipients } : {})
      }
    );
    
    // Check if no messages remain after filtering
    if (Object.keys(correctedMessages).length === 0) {
      console.error(`[LeadFollowUp:${requestId}] ❌ CHANNEL FILTER ERROR: No valid messages remain after channel filtering`);
      
      // If we have no original messages, the problem is content extraction, not channel filtering
      if (Object.keys(messages).length === 0) {
        const diagnosticInfo = buildDiagnosticInfo(completedSalesCommand, channelConfig, salesFollowUpContent, finalContent, requestId);
        
        throw { 
            code: 'NO_CONTENT_GENERATED', 
            message: 'The AI command did not generate any follow-up content with a valid channel. This may indicate an issue with the command execution or response structure.',
            details: diagnosticInfo,
            status: 500 
        };
      }
      
      throw { 
        code: 'NO_VALID_CHANNELS', 
        message: 'No valid communication channels available for this message. The generated message channels are not configured for this site.',
        details: {
          available_channels: channelConfig.configuredChannels,
          original_channels: Object.keys(messages),
          corrections_applied: corrections
        },
        status: 400
      };
    }
    
    // 🔧 VALIDATION: Ensure at least one message survives after processing
    if (Object.keys(correctedMessages).length === 0) {
        // This case should be covered by the check above, but keeping it for safety
       throw { 
          code: 'NO_VALID_MESSAGES_AFTER_FILTERING', 
          message: 'No valid messages remained after channel filtering. This indicates a mismatch between generated content channels and configured channels.',
          status: 400
        };
    }
    
    // 🔧 CORRECCIÓN: Usar UUIDs de la base de datos en lugar de IDs internos
    const finalCommandIds = {
      sales: salesDbUuid || salesCommandId, // Priorizar UUID de DB
      copywriter: copywriterDbUuid || copywriterCommandId // Priorizar UUID de DB
    };
    
    if (outreachActivity) {
      for (const generated of Object.values(correctedMessages) as any[]) {
        generated.custom_data = { ...(generated.custom_data || {}), outreach_activity: outreachActivity };
      }
    }
    const responseData: any = {
      messages: correctedMessages, // Return filtered messages instead of original
      lead: effectiveLeadData || {},
      command_ids: finalCommandIds,
      ...(outreachActivity ? { outreach_activity: outreachActivity } : {})
    };
    
    // Add channel corrections if any were applied
    if (corrections.length > 0) {
      responseData.channel_corrections = {
        applied: corrections,
        configured_channels: channelConfig.configuredChannels,
        original_channels: Object.keys(messages)
      };
    }
    
    // Add tool execution status if tools were used
    if (completedSalesCommand?.functions) {
        responseData.tool_execution = buildToolExecutionMetadata(completedSalesCommand.functions, toolExecutionFailed, toolExecutionError);
    } else if (toolExecutionFailed) {
      // Even if no functions array, log the tool execution failure
      responseData.tool_execution = {
        total: 0,
        completed: 0,
        failed: 0,
        errors: [],
        execution_failed: true,
        execution_error: toolExecutionError ? (typeof toolExecutionError === 'string' ? toolExecutionError : JSON.stringify(toolExecutionError)).substring(0, 500) : null
      };
    }
    
    return responseData;
  }
}

export const leadFollowUpService = new LeadFollowUpService();
