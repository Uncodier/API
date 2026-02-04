import { safeStringify } from '@/lib/helpers/lead-context-helper';

export class LeadContextBuilder {
  
  static buildContextMessage(leadId: string, siteId: string, effectiveLeadData: any, effectivePreviousInteractions: any, productInterest: any, leadStage: any, followUpType: any, followUpInterval: any): string {
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
    
    return contextMessage;
  }
  
  static getConversationIntelligenceInstructions(): string {
    return `\n\n=== CONVERSATION HISTORY INTELLIGENCE ===\n` +
           `📚 ANALYZE THE CONVERSATION CONTEXT:\n` +
           `- Review ALL previous conversation messages provided above\n` +
           `- Identify if the lead has actively responded and engaged with previous messages\n` +
           `- Note the lead's communication style, tone, and level of interest\n` +
           `- Detect any specific questions, concerns, or topics the lead expressed interest in\n` +
           `- Check the conversation status (active/inactive) and last message timestamp\n\n` +
           `🎯 IF THE LEAD HAS RESPONDED (Engaged Lead):\n` +
           `- Continue the conversation naturally, acknowledging their previous messages\n` +
           `- Directly address any unanswered questions or concerns from past exchanges\n` +
           `- Build upon topics they showed interest in\n` +
           `- Reference specific points from their messages to show attentiveness\n` +
           `- Match their communication style and level of formality\n` +
           `- Provide relevant value based on what they've already shared\n` +
           `- Use the same channel where they last responded\n` +
           `- Consider using QUALIFY_LEAD tool to update status to "contacted" or "qualified" based on engagement level\n\n` +
           `❄️ IF THE LEAD HAS NOT RESPONDED (Unengaged/Cold Lead):\n` +
           `- Review what messages were already sent to avoid repetition\n` +
           `- Try a completely different angle, value proposition, or approach\n` +
           `- Consider switching to a different channel if available\n` +
           `- Keep the message brief, high-value, and non-pushy\n` +
           `- Include a clear, low-friction call-to-action\n` +
           `- CRITICAL: No response or multiple follow-ups without response does NOT qualify as "lost". Continue nurturing the lead.\n\n` +
           `📊 CONVERSATION STATUS GUIDELINES:\n` +
           `- Active conversation (status: active) → Lead is engaged, continue natural dialogue\n` +
           `- Inactive/closed conversation → Lead went cold, needs re-engagement strategy\n` +
           `- Multiple active conversations → Highly engaged lead, provide maximum value\n` +
           `- No previous conversations → First outreach, make strong first impression\n\n` +
           `⏱️ TIMING & CADENCE AWARENESS:\n` +
           `- Lead responded recently (< 24 hours) → Be responsive and timely, but not pushy\n` +
           `- Lead hasn't responded in days → Acknowledge the time gap politely if appropriate\n` +
           `- Multiple messages with no response → Reduce frequency, increase value\n` +
           `- Last message was yours and no response → Wait appropriately or try new approach\n\n` +
           `🔧 QUALIFY_LEAD TOOL USAGE:\n` +
           `- Use QUALIFY_LEAD tool to update lead status based on conversation analysis\n` +
           `- "contacted" → Lead has responded to your messages (first meaningful interaction). Use this for first outreach.\n` +
           `- "qualified" → Lead shows clear interest, asks questions, or requests information\n` +
           `- "converted" → Lead has made a purchase or committed to buy\n` +
           `- "lost" → ONLY use when: (a) Lead EXPLICITLY requests to stop being contacted (e.g., "stop contacting me", "remove me from your list", "I'm not interested, please stop"), OR (b) Lead clearly does NOT qualify as Ideal Customer Profile (ICP) based on company criteria (wrong industry, wrong company size, no budget, wrong geographic location, etc.)\n` +
           `- DO NOT mark as "lost" for: no response, multiple follow-ups without response, ambiguous interest, or first contact\n` +
           `- Update status AFTER analyzing conversation history, only when clear evidence exists\n` +
           `- If unsure about status, prefer "contacted" over "lost"\n` +
           `=== END OF CONVERSATION INTELLIGENCE ===\n`;
  }
  
  static getCopywritingGuidelines(): string {
    return `\n\n=== COPYWRITING GUIDELINES ===\n` +
           `🎯 IMPORTANT: If there are approved copywritings available for this lead or campaign, respect them as much as possible.\n` +
           `- Only personalize approved copywritings with lead-specific information to increase conversion\n` +
           `- Maintain the core message, tone, and structure of approved content\n` +
           `- Use lead data (name, company, pain points, etc.) to customize approved messages\n` +
           `- Focus on lead-specific personalization rather than completely rewriting approved content\n\n` +
           `=== HIGH-IMPACT CONTENT STRATEGY ===\n` +
           `The content of your email plays a huge role in whether it’s seen as a valuable message or as spam.\n\n` +
           `1. Personalize Everything\n` +
           `Address your recipients by name in the subject line and email body. Use other data points you have to make the email feel like a one-to-one conversation, not a mass blast. Generic emails are a major red flag for spam filters.\n\n` +
           `2. Write Like a Human, Not a Marketer\n` +
           `Avoid “spammy” keywords (e.g., “free,” “buy now,” “limited time offer”), excessive exclamation points, and using all caps. Write in a natural, conversational tone. The goal is to start a conversation, not to close a sale in the first email.\n\n` +
           `3. Be Strategic with images\n` +
           `Any type of image that isn’t an attachment but included in the message body actually sets off the spam alarms. Don’t do it. Also get rid of your open-tracker while you’re at it because how EVERY service checks if the recipient of your email opened your message is by encoding a small image into the body. Hurts deliverability!!\n\n` +
           `4. CTA Selection\n` +
           `Email providers are wary of emails links, especially in the first message of a conversation. A great strategy is to send your initial outreach with no links or images. Wait for the recipient to reply, and then send your call-to-action (CTA) link. This behavior is viewed far more favorably, as it’s now viewd as a “conversation.”\n\n` +
           `5. HTML + Text\n` +
           `Email providers oftentimes flag emails that only include HTML as spam. Providing a plain text alternative demonstrates the legitimacy of your message to providers like Gmail and increases the chances of it reaching the recipient’s inbox.\n\n` +
           `🌍 LANGUAGE & ACCENT GUIDELINES:\n` +
           `- Analyze the prospect's information (name, company, location, user agent, etc.) to determine their most likely language and accent\n` +
           `- Send messages in the language and accent most probable for the prospect based on their profile and context\n` +
           `- Consider cultural nuances and communication preferences when selecting language and tone\n` +
           `- Adapt the message style to match the prospect's likely cultural and linguistic background\n` +
           `=== END OF COPYWRITING GUIDELINES ===\n`;
  }
  
  static getLeadQualificationPolicy(): string {
    return `\n=== LEAD QUALIFICATION POLICY ===\n` +
           `Update the lead status using the QUALIFY_LEAD tool when appropriate, AFTER analyzing conversation history and only when clear evidence exists.\n` +
           `\nSTATUS DEFINITIONS:\n` +
           `- contacted → first meaningful two-way interaction (lead replies or attends a call). Use this for first outreach.\n` +
           `- qualified → ICP fit + clear interest (e.g., requested demo, positive signals, BANT fit, meeting booked)\n` +
           `- converted → deal won (payment received, contract signed, clear verbal commit with PO/date)\n` +
           `- lost → ONLY use when:\n` +
           `  (a) Lead EXPLICITLY requests to stop being contacted (e.g., "stop contacting me", "remove me from your list", "I'm not interested, please stop", "don't contact me again")\n` +
           `  (b) Lead clearly does NOT qualify as Ideal Customer Profile (ICP) based on company criteria (e.g., wrong industry, wrong company size, no budget, wrong geographic location, etc.)\n` +
           `\nCRITICAL PROHIBITIONS:\n` +
           `- DO NOT mark as "lost" unless the lead EXPLICITLY requests to stop being contacted OR clearly does not qualify as ICP\n` +
           `- DO NOT mark as "lost" for: no response, multiple follow-ups without response, ambiguous interest, or first contact\n` +
           `- When initiating first contact, mark as "contacted", NOT "lost"\n` +
           `- If unsure about status, prefer "contacted" over "lost"\n` +
           `\nWHEN TO USE QUALIFY_LEAD:\n` +
           `- After each significant interaction that changes the pipeline stage.\n` +
           `- Immediately after booking a meeting (qualified) or closing a sale (converted).\n` +
           `- After explicit rejection or clear ICP disqualification (use lost only in these cases; do not invent statuses).\n` +
           `\nHOW TO CALL QUALIFY_LEAD (only one identifier is needed in addition to site_id):\n` +
           `- Required fields: site_id, status; Optional: lead_id | email | phone, notes.\n` +
           `Return to drafting messages only after ensuring the status is updated (if status update is needed).\n`;
  }
  
  static getChannelSelectionInstructions(availableChannels: string[]): string {
    let contextMessage = `\n\n=== AVAILABLE COMMUNICATION CHANNELS ===\n`;
    contextMessage += `The following channels are CONFIGURED and AVAILABLE for this lead:\n`;
    contextMessage += `CONFIGURED CHANNELS: ${availableChannels.join(', ')}\n\n`;
    
    if (availableChannels.includes('email')) {
      contextMessage += `• EMAIL: Professional communication, detailed information, document attachments\n`;
    }
    if (availableChannels.includes('whatsapp')) {
      contextMessage += `• WHATSAPP: Immediate communication, casual messaging, mobile-first leads\n`;
    }
    if (availableChannels.includes('notification')) {
      contextMessage += `• NOTIFICATION: In-app notifications for active platform users, short messages\n`;
    }
    if (availableChannels.includes('web')) {
      contextMessage += `• WEB: Website popups/banners for visitors, offers and demos\n`;
    }
    
    contextMessage += `\n=== CRITICAL INSTRUCTIONS FOR CHANNEL SELECTION ===\n`;
    contextMessage += `🚨 FUNDAMENTAL RULE: ONLY CONTACT THROUGH ONE CHANNEL AT A TIME 🚨\n`;
    contextMessage += `- NEVER use multiple channels simultaneously\n`;
    contextMessage += `- A lead should receive communication through only one channel per interaction\n`;
    contextMessage += `- Contacting through multiple channels creates annoyance and may push prospects away\n`;
    contextMessage += `- Choose the channel MOST LIKELY to generate a positive response\n`;
    
    contextMessage += `\n🚨 VALIDATION RULES 🚨\n`;
    contextMessage += `- You MUST select a channel that is BOTH configured for the site AND has required contact info for the lead\n`;
    contextMessage += `- VALID CHANNELS: You can ONLY select from: ${availableChannels.join(', ')}\n`;
    contextMessage += `- If you select an invalid channel (not in the list above or missing required contact info), the system will fail - be precise\n`;
    contextMessage += `- Email channel requires: lead must have a valid email address\n`;
    contextMessage += `- WhatsApp channel requires: lead must have a valid phone number\n`;
    contextMessage += `- Notification and Web channels: always available (no specific contact info required)\n`;
    
    contextMessage += `\nPREFERENCE HEURISTICS:\n`;
    contextMessage += `- If the lead has NO email but has a phone, and WhatsApp is configured for the site, prefer WHATSAPP.\n`;
    contextMessage += `- If the lead has NO phone but has an email, and Email is configured, prefer EMAIL.\n`;
    contextMessage += `- If both are available and configured, choose based on persona/context (e.g., quick mobile contact → WhatsApp; formal/business or attachments → Email).\n`;
    contextMessage += `- If you choose a channel that is NOT available for the lead (missing email/phone) or NOT configured for the site, you MUST select the valid alternative from the configured channels list.\n`;
    contextMessage += `\n⚠️ IMPORTANT: You MUST select and return content for ONLY ONE CHANNEL from the configured list: ${availableChannels.join(', ')}\n`;
    contextMessage += `⚠️ Base your decision on the lead's history, context, and profile shown above.\n`;
    contextMessage += `\n🚫 SIGNATURE RULES: DO NOT add any signature, sign-off, or identification as an AI agent.\n`;
    contextMessage += `Messages are sent from real company employees' email addresses and should not include agent signatures.\n`;
    contextMessage += `=== END OF INSTRUCTIONS ===\n\n`;
    
    return contextMessage;
  }
}

