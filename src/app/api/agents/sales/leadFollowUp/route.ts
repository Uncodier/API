import { NextResponse } from 'next/server';
import { CommandFactory } from '@/lib/agentbase';
import { v4 as uuidv4 } from 'uuid';
import { 
  getLeadInfo, 
  getPreviousInteractions, 
  buildEnrichedContext,
  safeStringify
} from '@/lib/helpers/lead-context-helper';
import {
  parseIncomingRequest,
  isValidUUID,
  isValidPhoneNumber,
  getCommandDbUuid,
  findActiveAgentByRole,
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



export async function POST(request: Request) {
  const requestId = uuidv4();
  
  try {
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
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'siteId is required', trace_id: requestId } },
        { status: 400 }
      );
    }
    
    if (!leadId) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'leadId is required', trace_id: requestId } },
        { status: 400 }
      );
    }

    // Strong UUID validation with clear early errors
    if (!isValidUUID(siteId)) {
      console.error(`[LeadFollowUp:${requestId}] INVALID siteId UUID: ${siteId}`);
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_INPUT', message: 'siteId must be a valid UUID', trace_id: requestId } },
        { status: 400 }
      );
    }
    if (!isValidUUID(leadId)) {
      console.error(`[LeadFollowUp:${requestId}] INVALID leadId UUID: ${leadId}`);
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_INPUT', message: 'leadId must be a valid UUID', trace_id: requestId } },
        { status: 400 }
      );
    }
    
    // Validate phone_number if provided (prevent empty strings and invalid formats)
    if (phone_number !== undefined && !isValidPhoneNumber(phone_number)) {
      console.error(`[LeadFollowUp:${requestId}] ❌ INVALID phone_number: "${phone_number}" (length: ${phone_number?.length || 0})`);
      console.log(`[LeadFollowUp:${requestId}] 📱 Phone validation failed - rejecting request to prevent empty/invalid WhatsApp attempts`);
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_PHONE_NUMBER', 
            message: 'phone_number must be a valid phone number with at least 7 digits. Empty strings are not allowed.', 
            trace_id: requestId 
          } 
        },
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
        { success: false, error: { code: 'INVALID_REQUEST', message: 'userId is required and no active agent found for the site', trace_id: requestId } },
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
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'NO_CHANNELS_CONFIGURED',
            message: 'Site has no communication channels configured. Configure email or WhatsApp in settings before sending messages.',
            details: channelConfig.warning || 'No channels configured',
            action_taken: 'Channels setup notification attempted',
            trace_id: requestId
          }
        },
        { status: 400 }
      );
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
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'NO_VALID_CHANNELS_FOR_LEAD',
            message: 'No valid configured channel matches this lead contact info.',
            details: {
              configured_channels: channelConfig.configuredChannels,
              lead_has_email: hasEmail,
              lead_has_phone: hasPhone
            },
            trace_id: requestId
          }
        },
        { status: 400 }
      );
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
    
    // Add conversation history intelligence instructions
    contextMessage += `\n\n=== CONVERSATION HISTORY INTELLIGENCE ===\n`;
    contextMessage += `📚 ANALYZE THE CONVERSATION CONTEXT:\n`;
    contextMessage += `- Review ALL previous conversation messages provided above\n`;
    contextMessage += `- Identify if the lead has actively responded and engaged with previous messages\n`;
    contextMessage += `- Note the lead's communication style, tone, and level of interest\n`;
    contextMessage += `- Detect any specific questions, concerns, or topics the lead expressed interest in\n`;
    contextMessage += `- Check the conversation status (active/inactive) and last message timestamp\n\n`;

    contextMessage += `🎯 IF THE LEAD HAS RESPONDED (Engaged Lead):\n`;
    contextMessage += `- Continue the conversation naturally, acknowledging their previous messages\n`;
    contextMessage += `- Directly address any unanswered questions or concerns from past exchanges\n`;
    contextMessage += `- Build upon topics they showed interest in\n`;
    contextMessage += `- Reference specific points from their messages to show attentiveness\n`;
    contextMessage += `- Match their communication style and level of formality\n`;
    contextMessage += `- Provide relevant value based on what they've already shared\n`;
    contextMessage += `- Use the same channel where they last responded\n`;
    contextMessage += `- Consider using QUALIFY_LEAD tool to update status to "contacted" or "qualified" based on engagement level\n\n`;

    contextMessage += `❄️ IF THE LEAD HAS NOT RESPONDED (Unengaged/Cold Lead):\n`;
    contextMessage += `- Review what messages were already sent to avoid repetition\n`;
    contextMessage += `- Try a completely different angle, value proposition, or approach\n`;
    contextMessage += `- Consider switching to a different channel if available\n`;
    contextMessage += `- Keep the message brief, high-value, and non-pushy\n`;
    contextMessage += `- Include a clear, low-friction call-to-action\n`;
    contextMessage += `- CRITICAL: No response or multiple follow-ups without response does NOT qualify as "lost". Continue nurturing the lead.\n\n`;

    contextMessage += `📊 CONVERSATION STATUS GUIDELINES:\n`;
    contextMessage += `- Active conversation (status: active) → Lead is engaged, continue natural dialogue\n`;
    contextMessage += `- Inactive/closed conversation → Lead went cold, needs re-engagement strategy\n`;
    contextMessage += `- Multiple active conversations → Highly engaged lead, provide maximum value\n`;
    contextMessage += `- No previous conversations → First outreach, make strong first impression\n\n`;

    contextMessage += `⏱️ TIMING & CADENCE AWARENESS:\n`;
    contextMessage += `- Lead responded recently (< 24 hours) → Be responsive and timely, but not pushy\n`;
    contextMessage += `- Lead hasn't responded in days → Acknowledge the time gap politely if appropriate\n`;
    contextMessage += `- Multiple messages with no response → Reduce frequency, increase value\n`;
    contextMessage += `- Last message was yours and no response → Wait appropriately or try new approach\n\n`;

    contextMessage += `🔧 QUALIFY_LEAD TOOL USAGE:\n`;
    contextMessage += `- Use QUALIFY_LEAD tool to update lead status based on conversation analysis\n`;
    contextMessage += `- "contacted" → Lead has responded to your messages (first meaningful interaction). Use this for first outreach.\n`;
    contextMessage += `- "qualified" → Lead shows clear interest, asks questions, or requests information\n`;
    contextMessage += `- "converted" → Lead has made a purchase or committed to buy\n`;
    contextMessage += `- "lost" → ONLY use when: (a) Lead EXPLICITLY requests to stop being contacted (e.g., "stop contacting me", "remove me from your list", "I'm not interested, please stop"), OR (b) Lead clearly does NOT qualify as Ideal Customer Profile (ICP) based on company criteria (wrong industry, wrong company size, no budget, wrong geographic location, etc.)\n`;
    contextMessage += `- DO NOT mark as "lost" for: no response, multiple follow-ups without response, ambiguous interest, or first contact\n`;
    contextMessage += `- Update status AFTER analyzing conversation history, only when clear evidence exists\n`;
    contextMessage += `- If unsure about status, prefer "contacted" over "lost"\n`;
    contextMessage += `=== END OF CONVERSATION INTELLIGENCE ===\n`;
    
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

    // Lead Qualification Policy & Tool Usage
    contextMessage += `\n=== LEAD QUALIFICATION POLICY ===\n`;
    contextMessage += `Update the lead status using the QUALIFY_LEAD tool when appropriate, AFTER analyzing conversation history and only when clear evidence exists.\n`;
    contextMessage += `\nSTATUS DEFINITIONS:\n`;
    contextMessage += `- contacted → first meaningful two-way interaction (lead replies or attends a call). Use this for first outreach.\n`;
    contextMessage += `- qualified → ICP fit + clear interest (e.g., requested demo, positive signals, BANT fit, meeting booked)\n`;
    contextMessage += `- converted → deal won (payment received, contract signed, clear verbal commit with PO/date)\n`;
    contextMessage += `- lost → ONLY use when:\n`;
    contextMessage += `  (a) Lead EXPLICITLY requests to stop being contacted (e.g., "stop contacting me", "remove me from your list", "I'm not interested, please stop", "don't contact me again")\n`;
    contextMessage += `  (b) Lead clearly does NOT qualify as Ideal Customer Profile (ICP) based on company criteria (e.g., wrong industry, wrong company size, no budget, wrong geographic location, etc.)\n`;
    contextMessage += `\nCRITICAL PROHIBITIONS:\n`;
    contextMessage += `- DO NOT mark as "lost" unless the lead EXPLICITLY requests to stop being contacted OR clearly does not qualify as ICP\n`;
    contextMessage += `- DO NOT mark as "lost" for: no response, multiple follow-ups without response, ambiguous interest, or first contact\n`;
    contextMessage += `- When initiating first contact, mark as "contacted", NOT "lost"\n`;
    contextMessage += `- If unsure about status, prefer "contacted" over "lost"\n`;
    contextMessage += `\nWHEN TO USE QUALIFY_LEAD:\n`;
    contextMessage += `- After each significant interaction that changes the pipeline stage.\n`;
    contextMessage += `- Immediately after booking a meeting (qualified) or closing a sale (converted).\n`;
    contextMessage += `- After explicit rejection or clear ICP disqualification (use lost only in these cases; do not invent statuses).\n`;
    contextMessage += `\nHOW TO CALL QUALIFY_LEAD (only one identifier is needed in addition to site_id):\n`;
    contextMessage += `- Required fields: site_id, status; Optional: lead_id | email | phone, notes.\n`;
    contextMessage += `Return to drafting messages only after ensuring the status is updated (if status update is needed).\n`;

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
    contextMessage += `\nPREFERENCE HEURISTICS:\n`;
    contextMessage += `- If the lead has NO email but has a phone, and WhatsApp is configured for the site, prefer WHATSAPP.\n`;
    contextMessage += `- If the lead has NO phone but has an email, and Email is configured, prefer EMAIL.\n`;
    contextMessage += `- If both are available and configured, choose based on persona/context (e.g., quick mobile contact → WhatsApp; formal/business or attachments → Email).\n`;
    contextMessage += `- If you choose a channel that is NOT available for the lead (missing email/phone) or NOT configured for the site, you MUST propose the valid alternative instead.\n`;
    contextMessage += `\n⚠️ IMPORTANT: You MUST select and return content for ONLY ONE CHANNEL.\n`;
    contextMessage += `⚠️ Base your decision on the lead's history, context, and profile shown above.\n`;
    contextMessage += `\n🚫 SIGNATURE RULES: DO NOT add any signature, sign-off, or identification as an AI agent.\n`;
    contextMessage += `Messages are sent from real company employees' email addresses and should not include agent signatures.\n`;
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
            message_language: "language for the message content (e.g., 'en', 'es', 'fr')",
            title: "compelling title or subject line for the selected channel",
            message: "personalized message content optimized for the chosen channel",
            channel: "the single most effective channel selected (email/whatsapp/notification/web)"
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
      // Continue processing - don't crash
      // Tool execution failures don't prevent command completion if we have results
    }
    
    // Validate tool execution results if they exist
    if (completedSalesCommand?.functions && Array.isArray(completedSalesCommand.functions)) {
      const toolResults = completedSalesCommand.functions;
      console.log(`🔧 PHASE 1: Validating ${toolResults.length} tool execution results`);
      
      toolResults.forEach((toolResult: any, index: number) => {
        const toolName = toolResult.function_name || toolResult.name || 'unknown';
        const toolStatus = toolResult.status || 'unknown';
        
        console.log(`🔧 PHASE 1: Tool #${index + 1} (${toolName}): status=${toolStatus}`);
        
        if (toolStatus === 'error' || toolStatus === 'failed') {
          console.warn(`⚠️ PHASE 1: Tool ${toolName} execution failed:`, toolResult.error);
          // This is expected if tool_execution_failed is true, continue processing
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
                  console.warn(`⚠️ PHASE 1: Output keys:`, outputKeys);
                }
              }
            } catch (validationError: any) {
              console.warn(`⚠️ PHASE 1: Error validating tool ${toolName} output:`, validationError.message);
            }
          }
        }
      });
    }
    
    // Update completion check logic: allow processing even if status is 'failed' but results are available
    // Change from: !salesCompleted || !completedSalesCommand
    // To: !completedSalesCommand || (!salesCompleted && !hasValidResults)
    const hasValidResults = completedSalesCommand?.results && Array.isArray(completedSalesCommand.results) && completedSalesCommand.results.length > 0;
    
    if (!completedSalesCommand || (!salesCompleted && !hasValidResults)) {
      console.error(`❌ PHASE 1: Sales command did not complete correctly and has no recoverable results`);
      
      // Provide more detailed error information
      const errorDetails = {
        commandId: salesCommandId,
        completed: salesCompleted,
        hasCommand: !!completedSalesCommand,
        commandStatus: completedSalesCommand?.status || 'unknown',
        hasResults: hasValidResults
      };
      
      console.error(`❌ PHASE 1: Error details:`, errorDetails);
      
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'SALES_COMMAND_FAILED', 
            message: 'Sales command did not complete successfully and has no recoverable results',
            details: errorDetails,
            tool_execution_error: toolExecutionError // Include tool error for debugging
          } 
        },
        { status: 500 }
      );
    }
    
    // Log if we're processing results even though command failed
    if (completedSalesCommand.status === 'failed' && hasValidResults) {
      console.warn(`⚠️ PHASE 1: Sales command failed but has recoverable results - processing anyway`);
    }
    
    // Extract follow-up content from results
    // Process results even if command status is 'failed' (like customerSupport does)
    let salesFollowUpContent = null;
    if (completedSalesCommand.results && Array.isArray(completedSalesCommand.results)) {
      console.log(`[LeadFollowUp:${requestId}] 📋 Extracting content from ${completedSalesCommand.results.length} result(s)`);
      
      for (const result of completedSalesCommand.results) {
        console.log(`[LeadFollowUp:${requestId}] 🔍 Checking result structure:`, Object.keys(result));
        
        // Search for follow_up_content (now expecting object, not array)
        if (result.follow_up_content && typeof result.follow_up_content === 'object' && !Array.isArray(result.follow_up_content)) {
          salesFollowUpContent = result.follow_up_content;
          console.log(`[LeadFollowUp:${requestId}] ✅ Found follow_up_content (object):`, {
            hasChannel: !!salesFollowUpContent.channel,
            channel: salesFollowUpContent.channel,
            hasTitle: !!salesFollowUpContent.title,
            hasMessage: !!salesFollowUpContent.message
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
      
      if (!salesFollowUpContent) {
        console.warn(`[LeadFollowUp:${requestId}] ⚠️ No follow_up_content found in results. Full results structure:`, 
          JSON.stringify(completedSalesCommand.results, null, 2).substring(0, 1000));
      }
    }
    
    // Verify if we have valid content
    // Process results even if command status is 'failed' (like customerSupport does)
    if (!salesFollowUpContent || typeof salesFollowUpContent !== 'object') {
      console.error(`❌ PHASE 1: Could not extract follow-up content from results`);
      
      // If the command failed, try to create fallback content (similar to customerSupport approach)
      if (completedSalesCommand.status === 'failed' || !salesCompleted) {
        // Check if we have error information that might be useful
        const errorResult = completedSalesCommand.results?.find((r: any) => r.error || r.error_type);
        if (errorResult) {
          // Create a basic fallback content structure
          salesFollowUpContent = {
            strategy: "Follow-up strategy (generated after tool execution error)",
            title: "Personalized Follow-up",
            message: "Thank you for your interest. We'd like to follow up on your inquiry and provide you with more information that might be helpful.",
            channel: "email", // Default to email as safest option
            _metadata: {
              fallback: true,
              original_error: errorResult.error_type || completedSalesCommand.error,
              command_status: completedSalesCommand.status,
              generated_at: new Date().toISOString()
            }
          };
        }
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
    let finalContent = [];
    
    console.log(`[LeadFollowUp:${requestId}] 📦 Extracting final content from ${copywriterCompleted ? 'copywriter' : 'sales'} command`);
    
    // Extract content from final command
    if (finalCommand && finalCommand.results && Array.isArray(finalCommand.results)) {
      console.log(`[LeadFollowUp:${requestId}] 📋 Processing ${finalCommand.results.length} result(s) from final command`);
      
      for (const result of finalCommand.results) {
        console.log(`[LeadFollowUp:${requestId}] 🔍 Checking result keys:`, Object.keys(result));
        
        // For copywriter, search for refined_content (can be object or array)
        if (copywriterCompleted && result.refined_content) {
          if (Array.isArray(result.refined_content)) {
            finalContent = result.refined_content;
            console.log(`[LeadFollowUp:${requestId}] ✅ Found refined_content (array): ${finalContent.length} items`);
          } else if (typeof result.refined_content === 'object') {
            finalContent = [result.refined_content]; // Convert object to array
            console.log(`[LeadFollowUp:${requestId}] ✅ Found refined_content (object), converted to array`);
          }
          break;
        }
        // For sales, search for follow_up_content (can be object or array)
        else if (!copywriterCompleted && result.follow_up_content) {
          if (Array.isArray(result.follow_up_content)) {
            finalContent = result.follow_up_content;
            console.log(`[LeadFollowUp:${requestId}] ✅ Found follow_up_content (array): ${finalContent.length} items`);
          } else if (typeof result.follow_up_content === 'object') {
            finalContent = [result.follow_up_content]; // Convert object to array
            console.log(`[LeadFollowUp:${requestId}] ✅ Found follow_up_content (object), converted to array`);
          }
          break;
        }
        // Fallbacks
        else if (result.content && Array.isArray(result.content)) {
          finalContent = result.content;
          console.log(`[LeadFollowUp:${requestId}] ✅ Found content (array): ${finalContent.length} items`);
          break;
        }
        else if (result.content && typeof result.content === 'object') {
          finalContent = [result.content]; // Convert object to array
          console.log(`[LeadFollowUp:${requestId}] ✅ Found content (object), converted to array`);
          break;
        }
        else if (Array.isArray(result)) {
          finalContent = result;
          console.log(`[LeadFollowUp:${requestId}] ✅ Result is array directly: ${finalContent.length} items`);
          break;
        }
      }
    }
    
    // 🔧 FALLBACK: Si finalContent está vacío pero tenemos salesFollowUpContent, usarlo
    if ((!finalContent || finalContent.length === 0) && salesFollowUpContent && typeof salesFollowUpContent === 'object') {
      console.log(`[LeadFollowUp:${requestId}] 🔧 Using salesFollowUpContent as fallback`);
      finalContent = [salesFollowUpContent];
    }
    
    console.log(`[LeadFollowUp:${requestId}] 📊 Final content extracted: ${finalContent.length} item(s)`, 
      finalContent.length > 0 ? finalContent.map((item: any) => ({
        hasChannel: !!item.channel,
        channel: item.channel,
        hasTitle: !!item.title,
        hasMessage: !!item.message
      })) : 'No items');
    
    // Organize messages by channel
    const messages: any = {};
    
    if (finalContent && Array.isArray(finalContent)) {
      finalContent.forEach((item: any, index: number) => {
        console.log(`[LeadFollowUp:${requestId}] 🔍 Processing item ${index}:`, {
          hasChannel: !!item.channel,
          channel: item.channel,
          keys: Object.keys(item)
        });
        
        if (item.channel) {
          messages[item.channel] = {
            title: item.title || '',
            message: item.message || '',
            strategy: item.strategy || ''
          };
          console.log(`[LeadFollowUp:${requestId}] ✅ Added message for channel: ${item.channel}`);
        } else {
          console.warn(`[LeadFollowUp:${requestId}] ⚠️ Item ${index} has no channel property:`, Object.keys(item));
        }
      });
    } else {
      console.error(`[LeadFollowUp:${requestId}] ❌ MESSAGE STRUCTURING: finalContent is not a valid array`, {
        isArray: Array.isArray(finalContent),
        type: typeof finalContent,
        value: finalContent
      });
    }
    
    console.log(`[LeadFollowUp:${requestId}] 📨 Messages organized:`, {
      channels: Object.keys(messages),
      count: Object.keys(messages).length
    });
    
    // ===== MANUAL CHANNEL FILTERING =====
    console.log(`🔧 STARTING MANUAL CHANNEL FILTERING FOR SITE: ${siteId}`);
    
    // Channel configuration was already fetched earlier
    console.log(`[LeadFollowUp:${requestId}] 📡 Channel configuration (reused):`, channelConfig);
    
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
            action_taken: 'Channels setup notification sent to team members',
            trace_id: requestId
          } 
        },
        { status: 400 }
      );
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
      console.error(`[LeadFollowUp:${requestId}] 📊 Debug info:`, {
        originalMessagesCount: Object.keys(messages).length,
        originalChannels: Object.keys(messages),
        configuredChannels: channelConfig.configuredChannels,
        correctionsApplied: corrections,
        hasSalesContent: !!salesFollowUpContent,
        salesContentChannel: salesFollowUpContent?.channel,
        finalContentLength: finalContent?.length || 0
      });
      
      // If we have no original messages, the problem is content extraction, not channel filtering
      if (Object.keys(messages).length === 0) {
        return NextResponse.json(
          { 
            success: false, 
            error: { 
              code: 'NO_CONTENT_GENERATED', 
              message: 'The AI command did not generate any follow-up content with a valid channel. This may indicate an issue with the command execution or response structure.',
              details: {
                command_status: completedSalesCommand?.status || 'unknown',
                has_results: !!(completedSalesCommand?.results && completedSalesCommand.results.length > 0),
                results_count: completedSalesCommand?.results?.length || 0,
                configured_channels: channelConfig.configuredChannels,
                trace_id: requestId
              },
              trace_id: requestId
            } 
          },
          { status: 500 }
        );
      }
      
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
            },
            trace_id: requestId
          } 
        },
        { status: 400 }
      );
    }
    
    // ===== END MANUAL CHANNEL FILTERING =====
    
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
    if (completedSalesCommand?.functions && completedSalesCommand.functions.length > 0) {
      const toolsExecuted = completedSalesCommand.functions.length;
      const toolsFailed = completedSalesCommand.functions.filter((f: any) => f.status === 'failed' || f.status === 'error').length;
      const toolsCompleted = completedSalesCommand.functions.filter((f: any) => f.status === 'completed' || f.status === 'success').length;
      
      // Extract tool execution details safely
      const toolErrors: string[] = [];
      completedSalesCommand.functions.forEach((f: any) => {
        if ((f.status === 'failed' || f.status === 'error') && f.error) {
          const toolName = f.name || f.function_name || 'unknown';
          const errorMsg = typeof f.error === 'string' ? f.error : JSON.stringify(f.error);
          toolErrors.push(`${toolName}: ${errorMsg.substring(0, 200)}`); // Limit error message length
        }
      });
      
      responseData.tool_execution = {
        total: toolsExecuted,
        completed: toolsCompleted,
        failed: toolsFailed,
        errors: toolErrors,
        execution_failed: toolExecutionFailed,
        execution_error: toolExecutionError ? (typeof toolExecutionError === 'string' ? toolExecutionError : JSON.stringify(toolExecutionError)).substring(0, 500) : null
      };
      
      console.log(`🔧 [DIAGNOSTIC] Tool execution metadata created:`, {
        total: responseData.tool_execution.total,
        completed: responseData.tool_execution.completed,
        failed: responseData.tool_execution.failed,
        execution_failed: responseData.tool_execution.execution_failed
      });
      
      if (toolsFailed > 0) {
        console.warn(`⚠️ ${toolsFailed}/${toolsExecuted} tools failed during execution`);
        console.warn(`⚠️ Tool execution failures are non-fatal - command completed successfully`);
      }
      
      if (toolExecutionFailed) {
        console.warn(`⚠️ Tool execution failed at command level, but processing continued with available results`);
      }
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
      console.warn(`⚠️ Tool execution failed but no functions array available`);
    }
    
    return NextResponse.json({
      success: true,
      data: responseData
    });
    
  } catch (error: any) {
    console.error(`❌ [LeadFollowUp:${requestId}] UNHANDLED ERROR:`, error);
    console.error(`❌ [LeadFollowUp:${requestId}] Error message:`, error.message);
    console.error(`❌ [LeadFollowUp:${requestId}] Stack trace:`, error.stack);
    
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'UNHANDLED_ERROR', 
          message: error.message || 'An internal system error occurred',
          trace_id: requestId
        } 
      },
      { status: 500 }
    );
  }
} 