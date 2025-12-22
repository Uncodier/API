import { CommandFactory } from '@/lib/agentbase';
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
    
    // If we still don't have a userId, error
    if (!effectiveUserId) {
      throw { code: 'INVALID_REQUEST', message: 'userId is required and no active agent found for the site', status: 400 };
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

    // Determine lead contact availability
    const hasEmail = !!(effectiveLeadData && effectiveLeadData.email && String(effectiveLeadData.email).trim() !== '');
    const hasPhone = !!(effectiveLeadData && effectiveLeadData.phone && String(effectiveLeadData.phone).trim() !== '');

    // Fetch site channel configuration EARLY (before any AI work)
    const channelConfig = await getSiteChannelsConfiguration(siteId);
    console.log(`[LeadFollowUp:${requestId}] 📡 [EARLY] Channel configuration result:`, channelConfig);

    // Early abort if site has no channels configured
    if (!channelConfig.hasChannels) {
      console.error(`❌ CHANNELS CONFIG: Site ${siteId} has no channels configured. Aborting before AI.`);
      try {
        await triggerChannelsSetupNotification(siteId);
      } catch (notificationError) {
        console.error(`⚠️ Failed to trigger channels setup notification:`, notificationError);
      }
      throw {
        code: 'NO_CHANNELS_CONFIGURED',
        message: 'Site has no communication channels configured. Configure email or WhatsApp in settings before sending messages.',
        details: channelConfig.warning || 'No channels configured',
        action_taken: 'Channels setup notification attempted',
        status: 400
      };
    }

    // Early abort if no configured channel matches lead contact data
    const canEmail = channelConfig.configuredChannels.includes('email') && hasEmail;
    const canWhatsApp = channelConfig.configuredChannels.includes('whatsapp') && hasPhone;
    if (!canEmail && !canWhatsApp) {
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
    const availableChannels = [];
    
    if (hasEmail && channelConfig.configuredChannels.includes('email')) {
      availableChannels.push('email');
    }
    if (hasPhone && channelConfig.configuredChannels.includes('whatsapp')) {
      availableChannels.push('whatsapp');
    }
    // Always add web and notification channels (don't depend on specific lead data)
    availableChannels.push('notification', 'web');
    
    console.log(`📋 Available channels for context: ${availableChannels.join(', ')}`);

    // Add specific instructions about channel selection to context
    contextMessage += LeadContextBuilder.getChannelSelectionInstructions(availableChannels);

    // PHASE 1: Create command for Sales/CRM Specialist
    console.log(`🚀 PHASE 1: Creating command for Sales/CRM Specialist`);
    const salesCommand = CommandFactory.createCommand({
      task: 'lead follow-up strategy',
      userId: effectiveUserId,
      agentId: effectiveAgentId,
      site_id: siteId,
      description: `Generate a personalized follow-up message for a qualified lead, focusing on addressing their pain points and interests, with appropriate timing between touchpoints. You want to delight and nurture the lead. 

CRITICAL VALIDATION RULES:
- MANDATORY: title and message must be non-empty strings with actual content. NEVER return empty title or message fields.
- CHANNEL VALIDATION: You MUST select ONLY from these configured channels: ${availableChannels.join(', ')}. If the lead lacks required contact info for a channel (e.g., no email for email channel, no phone for whatsapp), you MUST select the valid alternative from the configured channels.
- SINGLE CHANNEL: Based on the lead's history, profile and context, select ONLY the most effective channel to avoid harassing the user. Choose only 1 channel from the available ones, the one with the highest probability of success according to the lead's context.
- ERROR PREVENTION: If you select an invalid channel or return empty fields, the system will fail. Be precise and validate your output.`,
      targets: [
        {
          deep_thinking: `Analyze the lead information, their interaction history, preferences, and profile to determine the single most effective communication channel. 

VALIDATION CHECKLIST:
1. Review configured channels: ${availableChannels.join(', ')}
2. Verify lead has required contact info for selected channel (email for email channel, phone for whatsapp)
3. If selected channel is not available, choose valid alternative from configured channels
4. Consider factors like: lead's communication preferences, previous interactions, urgency level, lead stage, and professional context
5. Choose only ONE channel to avoid overwhelming the lead
6. Ensure you can generate meaningful, non-empty title and message content for the selected channel`
        },
        {
          follow_up_content: {
            strategy: "comprehensive sale strategy based on lead analysis",
            message_language: "language for the message content (e.g., 'en', 'es', 'fr')",
            title: "compelling title or subject line for the selected channel (MANDATORY: must be non-empty string with actual content)",
            message: "personalized message content optimized for the chosen channel (MANDATORY: must be non-empty string with actual content)",
            channel: `the single most effective channel selected - MUST be one of: ${availableChannels.join(', ')}. Validate that lead has required contact info for this channel.`
          }
        }
      ],
      context: contextMessage,
      model: 'openai:gpt-5-mini',
      supervisor: [
        {
          agent_role: 'sales_manager',
          status: 'not_initialized'
        },
        {
          agent_role: 'customer_success',
          status: 'not_initialized'
        }
      ],
      tools: [
        {
          type: "function",
          async: true,
          function: {
            name: 'QUALIFY_LEAD',
            description: 'Qualify or update lead status based on interaction outcome and company policy',
            parameters: {
              type: 'object',
              properties: {
                site_id: {
                  type: 'string',
                  description: 'Site UUID where the lead belongs (required)',
                  ...(siteId ? { enum: [siteId] } : {})
                },
                lead_id: {
                  type: 'string',
                  description: 'Lead UUID to qualify (one of lead_id, email, or phone is required)'
                },
                email: {
                  type: 'string',
                  description: 'Lead email as alternative identifier'
                },
                phone: {
                  type: 'string',
                  description: 'Lead phone as alternative identifier'
                },
                status: {
                  type: 'string',
                  enum: ['contacted', 'qualified', 'converted', 'lost'],
                  description: 'New lead status according to company rules'
                },
                notes: {
                  type: 'string',
                  description: 'Short reasoning for the qualification change'
                }
              },
              required: ['site_id', 'status'],
              oneOf: [
                { required: ['lead_id'] },
                { required: ['email'] },
                { required: ['phone'] }
              ],
              additionalProperties: false
            },
            strict: true
          }
        }
      ]
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
        this.validateToolExecutionResults(completedSalesCommand.functions);
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
    let salesFollowUpContent = this.extractSalesFollowUpContent(completedSalesCommand, requestId);
    
    // Verify if we have valid content
    if (!salesFollowUpContent || typeof salesFollowUpContent !== 'object') {
      console.error(`❌ PHASE 1: Could not extract follow-up content from results`);
      
      // If the command failed, try to create fallback content
      if (completedSalesCommand.status === 'failed' || !salesCompleted) {
        salesFollowUpContent = this.createFallbackContent(completedSalesCommand, availableChannels);
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
    let finalContent = this.extractFinalContent(finalCommand, copywriterCompleted, salesFollowUpContent, requestId, availableChannels);
    
    // Organize messages by channel
    const messages: any = this.organizeMessagesByChannel(finalContent, hasEmail, hasPhone, channelConfig, requestId);
    
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
        message: 'Site has no communication channels configured. Please configure at least email or WhatsApp channels in site settings before sending messages. Team members have been notified to set up channels.',
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
        leadPhone: effectiveLeadData?.phone || null
      }
    );
    
    // Check if no messages remain after filtering
    if (Object.keys(correctedMessages).length === 0) {
      console.error(`[LeadFollowUp:${requestId}] ❌ CHANNEL FILTER ERROR: No valid messages remain after channel filtering`);
      
      // If we have no original messages, the problem is content extraction, not channel filtering
      if (Object.keys(messages).length === 0) {
        const diagnosticInfo = this.buildDiagnosticInfo(completedSalesCommand, channelConfig, salesFollowUpContent, finalContent, requestId);
        
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
    
    // Add tool execution status if tools were used
    if (completedSalesCommand?.functions) {
        responseData.tool_execution = this.buildToolExecutionMetadata(completedSalesCommand.functions, toolExecutionFailed, toolExecutionError);
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
  
  // Helper methods to keep the main method clean
  
  private validateToolExecutionResults(toolResults: any[]) {
      console.log(`🔧 PHASE 1: Validating ${toolResults.length} tool execution results`);
      
      toolResults.forEach((toolResult: any, index: number) => {
        const toolName = toolResult.function_name || toolResult.name || 'unknown';
        const toolStatus = toolResult.status || 'unknown';
        
        console.log(`🔧 PHASE 1: Tool #${index + 1} (${toolName}): status=${toolStatus}`);
        
        if (toolStatus === 'error' || toolStatus === 'failed') {
          console.warn(`⚠️ PHASE 1: Tool ${toolName} execution failed:`, toolResult.error);
        } else if (toolStatus === 'success') {
          // Validate that output is not malformed
          if (toolResult.output) {
            try {
              const outputStr = typeof toolResult.output === 'string' 
                ? toolResult.output 
                : JSON.stringify(toolResult.output);
              
              if (outputStr.length > 10 * 1024 * 1024) {
                console.warn(`⚠️ PHASE 1: Tool ${toolName} output is very large (${Math.round(outputStr.length / 1024)}KB)`);
              }
              
              // Check for malformed responses (duplicate objects with string values)
              if (typeof toolResult.output === 'object' && !Array.isArray(toolResult.output)) {
                const outputKeys = Object.keys(toolResult.output);
                const hasStringValues = outputKeys.some(key => 
                  typeof toolResult.output[key] === 'string' && 
                  ['success', 'lead', 'status_changed', 'status_change', 'next_actions'].includes(toolResult.output[key])
                );
                
                if (hasStringValues) {
                  console.warn(`⚠️ PHASE 1: Tool ${toolName} output appears to have malformed response structure`);
                }
              }
            } catch (validationError: any) {
              console.warn(`⚠️ PHASE 1: Error validating tool ${toolName} output:`, validationError.message);
            }
          }
        }
      });
  }

  private extractSalesFollowUpContent(completedSalesCommand: any, requestId: string): any {
    let salesFollowUpContent = null;
    if (completedSalesCommand.results && Array.isArray(completedSalesCommand.results)) {
      console.log(`[LeadFollowUp:${requestId}] 📋 Extracting content from ${completedSalesCommand.results.length} result(s)`);
      
      for (const result of completedSalesCommand.results) {
        
        // Search for follow_up_content (now expecting object, not array)
        if (result.follow_up_content && typeof result.follow_up_content === 'object' && !Array.isArray(result.follow_up_content)) {
          salesFollowUpContent = result.follow_up_content;
          console.log(`[LeadFollowUp:${requestId}] ✅ Found follow_up_content (object):`, {
            hasChannel: !!salesFollowUpContent.channel,
            channel: salesFollowUpContent.channel
          });
          break;
        }
        
        // 🔧 FALLBACK: Handle flattened structure (temporary workaround)
        if (result.channel && result.title && result.message) {
          salesFollowUpContent = {
            channel: result.channel,
            title: result.title,
            message: result.message,
            strategy: result.strategy || '',
            message_language: result.message_language || 'en'
          };
          console.log(`[LeadFollowUp:${requestId}] ⚠️ Found flattened structure (fallback):`, {
            hasChannel: !!salesFollowUpContent.channel,
            channel: salesFollowUpContent.channel
          });
          break;
        }
        
        // Search for other possible structures
        if (result.content && typeof result.content === 'object' && !Array.isArray(result.content)) {
          salesFollowUpContent = result.content;
          console.log(`[LeadFollowUp:${requestId}] ✅ Found content (object):`, {
            hasChannel: !!salesFollowUpContent.channel,
            channel: salesFollowUpContent.channel
          });
          break;
        }
        
        // Legacy support for array format (convert first element)
        if (result.follow_up_content && Array.isArray(result.follow_up_content) && result.follow_up_content.length > 0) {
          salesFollowUpContent = result.follow_up_content[0];
          console.log(`[LeadFollowUp:${requestId}] ✅ Found follow_up_content (array, using first):`, {
            hasChannel: !!salesFollowUpContent.channel,
            channel: salesFollowUpContent.channel
          });
          break;
        }
      }
    }
    return salesFollowUpContent;
  }
  
  private createFallbackContent(completedSalesCommand: any, availableChannels: string[]): any {
      const errorResult = completedSalesCommand.results?.find((r: any) => r.error || r.error_type);
      if (errorResult) {
        // Validate that we have at least one available channel (should never be empty after early validation)
        if (availableChannels.length === 0) {
          console.error(`❌ CRITICAL: availableChannels is empty in createFallbackContent - this should never happen after early validation`);
          throw {
            code: 'NO_AVAILABLE_CHANNELS',
            message: 'No available channels found for fallback content. This indicates a system validation error.',
            status: 500
          };
        }
        
        // Use first available channel from validated list
        const fallbackChannel = availableChannels[0];
        
        return {
          strategy: "Follow-up strategy (generated after tool execution error)",
          title: "Personalized Follow-up",
          message: "Thank you for your interest. We'd like to follow up on your inquiry and provide you with more information that might be helpful.",
          channel: fallbackChannel,
          _metadata: {
            fallback: true,
            original_error: errorResult.error_type || completedSalesCommand.error,
            command_status: completedSalesCommand.status,
            generated_at: new Date().toISOString(),
            fallback_channel_source: 'availableChannels'
          }
        };
      }
      return null;
  }

  private extractFinalContent(finalCommand: any, copywriterCompleted: boolean, salesFollowUpContent: any, requestId: string, availableChannels: string[]): any[] {
    let finalContent: any[] = [];
    
    console.log(`[LeadFollowUp:${requestId}] 📦 Extracting final content from ${copywriterCompleted ? 'copywriter' : 'sales'} command`);
    
    // Helper function to normalize channel names (agent_email -> email, agent_whatsapp -> whatsapp)
    // Also normalizes to lowercase to handle case variations (Email -> email, EMAIL -> email)
    const normalizeChannel = (channel: string | undefined): string | undefined => {
      if (!channel) return undefined;
      const lowerChannel = channel.toLowerCase();
      if (lowerChannel === 'agent_email') return 'email';
      if (lowerChannel === 'agent_whatsapp') return 'whatsapp';
      return lowerChannel;
    };
    
    // Helper function to get a valid fallback channel from availableChannels
    const getValidFallbackChannel = (): string => {
      // Validate that we have at least one available channel (should never be empty after early validation)
      if (availableChannels.length === 0) {
        console.error(`❌ CRITICAL: availableChannels is empty in getValidFallbackChannel - this should never happen after early validation`);
        throw {
          code: 'NO_AVAILABLE_CHANNELS',
          message: 'No available channels found for fallback. This indicates a system validation error.',
          status: 500
        };
      }
      
      // Prefer notification or web as they're always available and don't require contact info
      const preferredFallback = availableChannels.find(ch => ch === 'notification' || ch === 'web');
      if (preferredFallback) return preferredFallback;
      
      // Otherwise use first available channel from validated list
      return availableChannels[0];
    };
    
    // Extract content from final command
    if (finalCommand && finalCommand.results && Array.isArray(finalCommand.results)) {
      console.log(`[LeadFollowUp:${requestId}] 📋 Processing ${finalCommand.results.length} result(s) from final command`);
      
      for (const result of finalCommand.results) {
        
        // For copywriter, search for refined_content (can be object or array) or flattened fields
        if (copywriterCompleted) {
          // CRITICAL: Always preserve channel from sales content - copywriter does not return channel
          // Normalize channel name and validate it's in availableChannels
          let preservedChannel = normalizeChannel(salesFollowUpContent?.channel);
          
          // If channel is not in availableChannels, use a valid fallback
          if (!preservedChannel || !availableChannels.includes(preservedChannel)) {
            const fallbackChannel = getValidFallbackChannel();
            console.log(`[LeadFollowUp:${requestId}] ⚠️ Sales channel '${preservedChannel || 'undefined'}' not in availableChannels [${availableChannels.join(', ')}], using fallback: ${fallbackChannel}`);
            preservedChannel = fallbackChannel;
          }
          
          if (result.refined_content) {
            if (Array.isArray(result.refined_content)) {
              // Always use preserved channel - copywriter should not modify channels
              // Remove any channel that copywriter might have returned
              finalContent = result.refined_content.map((item: any) => {
                const { channel: _, ...itemWithoutChannel } = item;
                return {
                  ...itemWithoutChannel,
                  channel: preservedChannel
                };
              });
            } else if (typeof result.refined_content === 'object') {
              // Always use preserved channel - copywriter should not modify channels
              // Remove any channel that copywriter might have returned
              const { channel: _, ...contentWithoutChannel } = result.refined_content;
              finalContent = [{
                ...contentWithoutChannel,
                channel: preservedChannel
              }];
            }
            break;
          }
          // Handle flattened fields (new format)
          else if (result.refined_title && result.refined_message) {
             finalContent = [{
                channel: preservedChannel, // Always use sales channel - copywriter doesn't modify it
                title: result.refined_title,
                message: result.refined_message
             }];
             console.log(`[LeadFollowUp:${requestId}] ✅ Found flattened refined content:`, {
                hasChannel: !!finalContent[0].channel,
                channel: finalContent[0].channel,
                note: 'Channel preserved from sales content'
             });
             break;
          }
        }
        // For sales, search for follow_up_content (can be object or array)
        else if (!copywriterCompleted && result.follow_up_content) {
          if (Array.isArray(result.follow_up_content)) {
            finalContent = result.follow_up_content;
          } else if (typeof result.follow_up_content === 'object') {
            finalContent = [result.follow_up_content]; // Convert object to array
          }
          break;
        }
        // 🔧 FALLBACK: Handle flattened structure for final extraction (temporary workaround)
        // CRITICAL FIX: Ensure this fallback DOES NOT trigger for copywriter results
        else if (!copywriterCompleted && result.channel && result.title && result.message) {
          finalContent = [{
            channel: result.channel,
            title: result.title,
            message: result.message,
            strategy: result.strategy || '',
            message_language: result.message_language || 'en'
          }];
          console.log(`[LeadFollowUp:${requestId}] ⚠️ Found flattened structure in final extraction (fallback):`, {
            channel: result.channel,
            note: 'Structure was flattened by agentbase, using fallback extraction'
          });
          break;
        }
        // Fallbacks
        else if (result.content && Array.isArray(result.content)) {
          finalContent = result.content;
          break;
        }
        else if (result.content && typeof result.content === 'object') {
          finalContent = [result.content]; // Convert object to array
          break;
        }
        else if (Array.isArray(result)) {
          finalContent = result;
          break;
        }
      }
    }
    
    // 🔧 FALLBACK: Si finalContent está vacío pero tenemos salesFollowUpContent, usarlo
    if ((!finalContent || finalContent.length === 0) && salesFollowUpContent && typeof salesFollowUpContent === 'object') {
      console.log(`[LeadFollowUp:${requestId}] 🔧 Using salesFollowUpContent as fallback`);
      finalContent = [salesFollowUpContent];
    }
    
    // 🔧 VALIDATION: Ensure all content items have a valid channel
    if (finalContent && finalContent.length > 0) {
      finalContent = finalContent.map((item: any) => {
        if (!item.channel) {
          // Try to use sales channel, but validate it's in availableChannels
          let channelToUse = normalizeChannel(salesFollowUpContent?.channel);
          
          if (!channelToUse || !availableChannels.includes(channelToUse)) {
            channelToUse = getValidFallbackChannel();
            console.log(`[LeadFollowUp:${requestId}] ⚠️ Missing or invalid channel in content item, using fallback: ${channelToUse}`);
          } else {
            console.log(`[LeadFollowUp:${requestId}] ⚠️ Missing channel in content item, using sales channel: ${channelToUse}`);
          }
          
          return {
            ...item,
            channel: channelToUse
          };
        } else {
          // Normalize and validate existing channel
          const normalizedChannel = normalizeChannel(item.channel);
          if (!normalizedChannel || !availableChannels.includes(normalizedChannel)) {
            const fallbackChannel = getValidFallbackChannel();
            console.log(`[LeadFollowUp:${requestId}] ⚠️ Invalid channel '${item.channel}' in content item, using fallback: ${fallbackChannel}`);
            return {
              ...item,
              channel: fallbackChannel
            };
          }
          // Update channel to normalized version if it was agent_email/agent_whatsapp
          if (normalizedChannel !== item.channel) {
            return {
              ...item,
              channel: normalizedChannel
            };
          }
        }
        return item;
      });
    }
    
    return finalContent;
  }
  
  private organizeMessagesByChannel(finalContent: any[], hasEmail: boolean, hasPhone: boolean, channelConfig: any, requestId: string): any {
    const messages: any = {};
    
    if (finalContent && Array.isArray(finalContent)) {
      finalContent.forEach((item: any, index: number) => {
        
        if (item.channel) {
          messages[item.channel] = {
            title: item.title || '',
            message: item.message || '',
            strategy: item.strategy || ''
          };
        } else {
          // 🔧 Channel inference: If content has title and message but no channel, infer from context
          if (item.title && item.message) {
            let inferredChannel: string | null = null;
            
            // Prefer email if lead has email and email is configured
            if (hasEmail && channelConfig.configuredChannels.includes('email')) {
              inferredChannel = 'email';
            }
            // Prefer whatsapp if lead has phone and whatsapp is configured
            else if (hasPhone && channelConfig.configuredChannels.includes('whatsapp')) {
              inferredChannel = 'whatsapp';
            }
            // Fallback to first configured channel
            else if (channelConfig.configuredChannels.length > 0) {
              inferredChannel = channelConfig.configuredChannels[0];
            }
            
            if (inferredChannel) {
              messages[inferredChannel] = {
                title: item.title || '',
                message: item.message || '',
                strategy: item.strategy || '',
                _metadata: {
                  channel_inferred: true,
                  original_channel: null
                }
              };
              console.log(`[LeadFollowUp:${requestId}] ⚠️ Item ${index} had no channel, inferred: ${inferredChannel}`);
            }
          }
        }
      });
    }
    return messages;
  }
  
  private buildDiagnosticInfo(completedSalesCommand: any, channelConfig: any, salesFollowUpContent: any, finalContent: any[], requestId: string): any {
      const diagnosticInfo: any = {
          command_status: completedSalesCommand?.status || 'unknown',
          has_results: !!(completedSalesCommand?.results && completedSalesCommand.results.length > 0),
          results_count: completedSalesCommand?.results?.length || 0,
          configured_channels: channelConfig.configuredChannels,
          trace_id: requestId
        };
        
        // Add detailed results structure
        if (completedSalesCommand?.results) {
          diagnosticInfo.results_structure = completedSalesCommand.results.map((r: any) => ({
            keys: Object.keys(r),
            has_follow_up_content: !!r.follow_up_content,
            has_channel: !!r.channel,
            has_title: !!r.title,
            has_message: !!r.message,
            sample_keys: Object.keys(r).slice(0, 10)
          }));
        }
        
        // Add extraction attempt info
        diagnosticInfo.extraction_attempts = {
          checked_follow_up_content: true,
          checked_flattened_structure: true,
          checked_content_field: true,
          sales_content_found: !!salesFollowUpContent,
          sales_content_channel: salesFollowUpContent?.channel || null,
          final_content_length: finalContent?.length || 0
        };
        return diagnosticInfo;
  }
  
  private buildToolExecutionMetadata(functions: any[], toolExecutionFailed: boolean, toolExecutionError: any): any {
      const toolsExecuted = functions.length;
      const toolsFailed = functions.filter((f: any) => f.status === 'failed' || f.status === 'error').length;
      const toolsCompleted = functions.filter((f: any) => f.status === 'completed' || f.status === 'success').length;
      
      const toolErrors: string[] = [];
      functions.forEach((f: any) => {
        if ((f.status === 'failed' || f.status === 'error') && f.error) {
          const toolName = f.name || f.function_name || 'unknown';
          const errorMsg = typeof f.error === 'string' ? f.error : JSON.stringify(f.error);
          toolErrors.push(`${toolName}: ${errorMsg.substring(0, 200)}`); // Limit error message length
        }
      });
      
      return {
        total: toolsExecuted,
        completed: toolsCompleted,
        failed: toolsFailed,
        errors: toolErrors,
        execution_failed: toolExecutionFailed,
        execution_error: toolExecutionError ? (typeof toolExecutionError === 'string' ? toolExecutionError : JSON.stringify(toolExecutionError)).substring(0, 500) : null
      };
  }
}

export const leadFollowUpService = new LeadFollowUpService();

