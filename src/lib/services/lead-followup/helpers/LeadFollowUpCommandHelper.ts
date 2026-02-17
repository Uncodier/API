import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { isValidUUID } from './LeadFollowUpUtils';

// Format site approved copywriting for copywriter context (explicit inclusion for adherence)
async function getSiteCopiesSection(siteId: string): Promise<string> {
  try {
    if (!isValidUUID(siteId)) return '';
    const { data, error } = await supabaseAdmin
      .from('copywriting')
      .select('*')
      .eq('site_id', siteId)
      .eq('status', 'approved')
      .order('created_at', { ascending: false });

    if (error || !data || data.length === 0) return '';

    const approved = data.filter((item: any) => item && item.status === 'approved' && item.copy_type && item.title && item.content);
    if (approved.length === 0) return '';

    const organized: Record<string, any[]> = {};
    approved.forEach((item: any) => {
      if (!organized[item.copy_type]) organized[item.copy_type] = [];
      organized[item.copy_type].push({
        title: item.title,
        content: item.content,
        target_audience: item.target_audience || null,
        use_case: item.use_case || null,
        notes: item.notes || null,
        tags: item.tags || []
      });
    });

    let section = `\n\n--- SITE APPROVED COPIES (MANDATORY ADHERENCE) ---\n`;
    section += `These are the site's approved copywriting templates. You MUST adhere to them strictly. Use them as foundation—only personalize with lead data (name, company, etc.). Preserve structure, tone, and key messaging.\n\n`;

    Object.entries(organized).forEach(([copyType, items]) => {
      const formattedType = copyType.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
      section += `### ${formattedType}\n`;
      items.forEach((item: any, idx: number) => {
        section += `${idx + 1}. **${item.title}**\n   Content: ${item.content}\n`;
        if (item.target_audience) section += `   Target Audience: ${item.target_audience}\n`;
        if (item.use_case) section += `   Use Case: ${item.use_case}\n`;
        if (item.notes) section += `   Notes: ${item.notes}\n`;
        if (item.tags?.length) section += `   Tags: ${item.tags.join(', ')}\n`;
        section += `\n`;
      });
    });
    section += `--- END SITE COPIES ---\n`;
    return section;
  } catch (e) {
    console.error('[LeadFollowUpCommandHelper] Error fetching site copies:', e);
    return '';
  }
}

// Initialize agent and get command service
const processorInitializer = ProcessorInitializer.getInstance();
processorInitializer.initialize();
export const commandService = processorInitializer.getCommandService();

// Function to get database UUID for a command
export async function getCommandDbUuid(internalId: string): Promise<string | null> {
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

// Function to wait for command completion
export async function waitForCommandCompletion(commandId: string, maxAttempts = 100, delayMs = 1000) {
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
        
        // Accept commands with status 'completed' OR 'failed' if they have valid results
        // This matches customerSupport behavior: process results even if status is 'failed'
        const hasValidResults = executedCommand.results && Array.isArray(executedCommand.results) && executedCommand.results.length > 0;
        const shouldAccept = executedCommand.status === 'completed' || 
                           (executedCommand.status === 'failed' && hasValidResults);
        
        if (shouldAccept) {
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
export async function executeCopywriterRefinement(
  siteId: string,
  agentId: string,
  userId: string,
  baseContext: string,
  salesFollowUpContent: any,
  leadId: string
): Promise<{ commandId: string; dbUuid: string | null; command: any } | null> {
  try {
    // Prepare context for second phase including first phase results
    let copywriterContext = baseContext;

    // Add site approved copies explicitly for greater adherence (copywriter may already have them in background)
    const siteCopiesSection = await getSiteCopiesSection(siteId);
    if (siteCopiesSection) {
      copywriterContext += siteCopiesSection;
    }

    // Add first phase results to context (channel, strategy, language only - NOT title/message; copywriter chooses those)
    if (salesFollowUpContent && typeof salesFollowUpContent === 'object') {
      copywriterContext += `\n\n--- SALES TEAM INPUT (Phase 1 Results) ---\n`;
      copywriterContext += `The Sales/CRM Specialist has selected the channel and strategic approach. YOU must create the title and message from scratch based on the lead context:\n\n`;
      
      copywriterContext += `SALES STRATEGIC INPUT (channel & approach only):\n`;
      copywriterContext += `├─ Channel: ${salesFollowUpContent.channel || 'Not specified'}\n`;
      copywriterContext += `├─ Strategy: ${salesFollowUpContent.strategy || 'Not specified'}\n`;
      copywriterContext += `└─ Message Language: ${salesFollowUpContent.message_language || 'Not specified'}\n\n`;
      
      copywriterContext += `--- COPYWRITER INSTRUCTIONS ---\n`;
      copywriterContext += `Your task is to CREATE the title and message for the follow-up. The sales team has selected the channel and strategy; you choose the actual copy.\n`;
      copywriterContext += `IMPORTANT: The sales team has selected the most effective channel (${salesFollowUpContent.channel}) to avoid overwhelming the lead. Use only this channel.\n`;
      
      copywriterContext += `\n🚨 CRITICAL VALIDATION RULES 🚨\n`;
      copywriterContext += `- MANDATORY: refined_title and refined_message must be non-empty strings with actual content. NEVER return empty refined_title or refined_message fields.\n`;
      copywriterContext += `- CRITICAL: DO NOT return the instruction text literally. The target descriptions (refined_title, refined_message) are INSTRUCTIONS for what to generate, NOT literal values to return. You must GENERATE actual content based on these instructions.\n`;
      copywriterContext += `- CHANNEL PRESERVATION: DO NOT return or modify the channel - it is already correctly set by the sales team to '${salesFollowUpContent.channel}'. The channel is handled automatically by the system.\n`;
      copywriterContext += `- ERROR PREVENTION: If you return empty fields, the system will fail. Always ensure your output contains valid, non-empty text.\n\n`;
      
      copywriterContext += `Your role is to CREATE compelling copy. You must:\n`;
      copywriterContext += `1. PRESERVE the original CHANNEL (${salesFollowUpContent.channel}) - DO NOT return or modify channel in your response\n`;
      copywriterContext += `2. CREATE an engaging TITLE appropriate for the channel and strategy (MANDATORY: must be non-empty string)\n`;
      copywriterContext += `3. CREATE a persuasive MESSAGE with clear value proposition and strong call-to-action (MANDATORY: must be non-empty string)\n`;
      copywriterContext += `4. OPTIMIZE language for emotional connection and sales objectives\n`;
      copywriterContext += `5. DO NOT use placeholders or variables like [Name], {Company}, {{Variable}}, etc.\n`;
      copywriterContext += `6. Use ONLY the real information provided in the lead context\n`;
      copywriterContext += `7. Write final content ready to send without additional editing\n`;
      copywriterContext += `8. SIGNATURE RULES: ALL CHANNELS already include automatic signatures/identifications, so DO NOT add any signature or sign-off. NEVER sign as the agent or AI - emails are sent from real company employees\n`;
      copywriterContext += `9. INTRODUCTION RULES: When introducing yourself or the company, always speak about the COMPANY, its RESULTS, ACHIEVEMENTS, or SERVICES - never about yourself as a person\n`;
      copywriterContext += `10. Focus on company value proposition, case studies, testimonials, or business outcomes rather than personal introductions\n`;
      copywriterContext += `11. 🎯 STRATEGIC ALIGNMENT: If a specific copy strategy or approved templates are available for this lead/campaign, you MUST adhere to them strictly. Use the established strategy as your foundation and only personalize where necessary to increase relevance and conversion.\n`;
      copywriterContext += `12. 🚨 EXPLICIT COPY & SEQUENCE ADHERENCE: When explicit copies, message templates, or predefined message sequences are provided, you MUST stick to them as closely as possible. Polish and personalize with lead data. Preserve structure, tone, and key messaging.\n`;
      copywriterContext += `13. ⛓️ SEQUENCE AWARENESS: Analyze the lead's position in the follow-up sequence. Adjust the tone and content based on how many times they've been contacted. If it's an early touchpoint, focus on curiosity and value; if it's a later one, increase the sense of urgency or offer a different perspective while remaining professional.\n`;
      copywriterContext += `14. 🚀 RESPONSE MAXIMIZATION: Your primary goal is to get a reply. Use strong hooks, psychological triggers (like social proof or reciprocity), and clear, low-friction calls-to-action to maximize the probability of a response.\n`;
      copywriterContext += `15. ⚠️ OUTPUT FORMAT: Return 'refined_title' and 'refined_message' as separate fields as requested. Do not wrap them in a 'content' object. DO NOT include 'channel' field - it is preserved automatically.\n\n`;
    }
    
    // Create command for copywriter based on available channels from phase 1
    // Build refinement target based on phase 1 content
    let refinementTarget: {title: string, message: string, channel: string} | null = null;
    
    if (salesFollowUpContent && typeof salesFollowUpContent === 'object' && salesFollowUpContent.channel) {
      const channel = salesFollowUpContent.channel;
      const messageLanguage = salesFollowUpContent.message_language || 'inferred from lead name, region, or company location';
      
      switch (channel) {
        case 'email':
          refinementTarget = {
            title: `Generate a refined and compelling email subject line that increases open rates. Write in ${messageLanguage}.`,
            message: `Generate an enhanced email message with persuasive copy, clear value proposition, and strong call-to-action. Write in ${messageLanguage}.`,
            channel: channel
          };
          break;
        case 'whatsapp':
          refinementTarget = {
            title: `Generate an improved WhatsApp message with casual yet professional tone. Write in ${messageLanguage}.`,
            message: `Generate refined WhatsApp content that feels personal, direct, and encourages immediate response. Write in ${messageLanguage}.`,
            channel: channel
          };
          break;
        case 'notification':
          refinementTarget = {
            title: `Generate an enhanced in-app notification that captures attention. Write in ${messageLanguage}.`,
            message: `Generate an optimized notification message that's concise, actionable, and drives user engagement. Write in ${messageLanguage}.`,
            channel: channel
          };
          break;
        case 'web':
          refinementTarget = {
            title: `Generate a polished web popup/banner headline that converts. Write in ${messageLanguage}.`,
            message: `Generate a compelling web message with persuasive copy that motivates visitors to take action. Write in ${messageLanguage}.`,
            channel: channel
          };
          break;
        default:
          refinementTarget = {
            title: `Generate a refined ${channel} headline with improved copy. Write in ${messageLanguage}.`,
            message: `Generate enhanced ${channel} message content with better persuasion and engagement. Write in ${messageLanguage}.`,
            channel: channel
          };
      }
    }
    
    if (!refinementTarget) {
      console.error(`❌ PHASE 2: Cannot create copywriter command - refinementTarget is null (missing channel in sales content?)`);
      return null;
    }
    
    const copywriterCommand = CommandFactory.createCommand({
      task: 'lead nurture copywriting',
      userId: userId,
      agentId: agentId,
      site_id: siteId,
      description: 'Refine and optimize lead follow-up content to maximize response rates. Act as a strategic writing coach, adjusting the tone based on the lead\'s position in the follow-up sequence and strictly adhering to any established copy strategies. Enhance clarity, flow, and persuasion while preserving the sales team\'s core intent and channel selection.',
      targets: [
        {
          deep_thinking: "Analyze the lead's follow-up history and sequence position. Identify the best copywriting approach to maximize response probability while strictly following any provided copy strategy. Evaluate the sales team's input and refine it to be more compelling, personalized, and effective for the specific channel selected."
        },
        {
          refined_title: refinementTarget.title,
          refined_message: refinementTarget.message
        }
      ],
      context: copywriterContext,
      model: 'openai:gpt-5.2',
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
    
    // Submit copywriter command
    const copywriterCommandId = await commandService.submitCommand(copywriterCommand);
    
    // Wait for copywriter command to complete
    const result = await waitForCommandCompletion(copywriterCommandId);
    
    if (result && result.completed && result.command) {
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
    console.error(`❌ PHASE 2: Error creating/executing copywriter command:`, error.message);
    return null;
  }
}
