import { supabaseAdmin } from '@/lib/database/supabase-client';
import { createTask } from '@/lib/database/task-db';
import { 
  getLeadInfo, 
  safeStringify 
} from '@/lib/helpers/lead-context-helper';
import { ConversationService } from '@/lib/services/conversation-service';

/**
 * Validates if a string is a valid UUID
 */
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

export class LeadFollowUpLogService {
  /**
   * Find or create a conversation for a specific channel
   */
  async getOrCreateChannelConversation(data: {
    siteId: string;
    leadId: string;
    userId: string;
    agentId?: string;
    channel: string;
    title?: string;
    commandIds?: { sales?: string; copywriter?: string };
  }): Promise<string | null> {
    try {
      // Don't create conversation for notifications
      if (data.channel === 'notification') {
        console.log(`🚫 Skipping conversation creation for notification channel`);
        return null;
      }

      // 1. Search for existing conversation for this lead and channel
      console.log(`🔍 Checking for existing conversation for lead ${data.leadId} on channel ${data.channel}`);
      const existingConversationId = await ConversationService.findExistingConversation(
        data.leadId,
        undefined,
        data.siteId,
        data.channel
      );

      if (existingConversationId) {
        console.log(`♻️ Reusing existing conversation: ${existingConversationId}`);
        return existingConversationId;
      }

      // 2. If no existing conversation, create a new one
      console.log(`✨ No existing conversation found, creating new one for channel ${data.channel}`);
      
      let effectiveCommandId: string | null = null;
      if (data.commandIds?.sales && isValidUUID(data.commandIds.sales)) {
        effectiveCommandId = data.commandIds.sales;
      } else if (data.commandIds?.copywriter && isValidUUID(data.commandIds.copywriter)) {
        effectiveCommandId = data.commandIds.copywriter;
      }

      const conversationData: any = {
        user_id: data.userId,
        site_id: data.siteId,
        lead_id: data.leadId,
        title: data.title || `${data.channel} Follow-up`,
        channel: data.channel,
        command_id: effectiveCommandId,
        custom_data: {
          channel: data.channel,
          follow_up_type: 'lead_nurture',
          command_ids: data.commandIds || {},
          delay_timer: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
        },
        status: 'pending'
      };

      if (data.agentId) {
        conversationData.agent_id = data.agentId;
      }

      const { data: conversation, error } = await supabaseAdmin
        .from('conversations')
        .insert([conversationData])
        .select()
        .single();

      if (error) {
        console.error(`Error creating conversation for channel ${data.channel}:`, error);
        return null;
      }

      console.log(`✅ New conversation created: ${conversation.id}`);
      return conversation.id;
    } catch (error) {
      console.error(`Error in getOrCreateChannelConversation for channel ${data.channel}:`, error);
      return null;
    }
  }

  /**
   * Create messages for each channel in their respective conversations
   */
  async createChannelMessages(params: {
    messages: Record<string, any>;
    leadData: any;
    siteId: string;
    leadId: string;
    userId: string;
    agentId?: string;
    commandIds?: { sales?: string; copywriter?: string };
    messageStatus?: string;
  }): Promise<{conversations: Record<string, string>, messages: Record<string, string>}> {
    const { messages, leadData, siteId, leadId, userId, agentId, commandIds, messageStatus = 'pending' } = params;
    const conversations: Record<string, string> = {};
    const channelMessages: Record<string, string> = {};
    
    for (const [channel, messageData] of Object.entries(messages)) {
      if (!messageData || typeof messageData !== 'object') continue;
      if (channel === 'notification') continue;

      const conversationId = await this.getOrCreateChannelConversation({
        siteId,
        leadId,
        userId,
        agentId,
        channel,
        title: messageData.title,
        commandIds
      });

      if (!conversationId) continue;
      conversations[channel] = conversationId;

      const messageContent = messageData.message || '';
      
      let effectiveCommandId: string | null = null;
      if (commandIds?.sales && isValidUUID(commandIds.sales)) {
        effectiveCommandId = commandIds.sales;
      } else if (commandIds?.copywriter && isValidUUID(commandIds.copywriter)) {
        effectiveCommandId = commandIds.copywriter;
      }

      const messageRecord: any = {
        conversation_id: conversationId,
        content: messageContent,
        role: 'system',
        user_id: userId,
        custom_data: {
          channel: channel,
          follow_up_type: 'lead_nurture',
          title: messageData.title,
          strategy: messageData.strategy,
          original_message: messageData.message,
          status: messageStatus,
          delay_timer: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
        }
      };

      if (leadData?.id) messageRecord.lead_id = leadData.id;
      if (agentId) messageRecord.agent_id = agentId;
      if (effectiveCommandId) messageRecord.command_id = effectiveCommandId;

      const { data: message, error } = await supabaseAdmin
        .from('messages')
        .insert([messageRecord])
        .select()
        .single();

      if (error) {
        console.error(`Error creating message for channel ${channel}:`, error);
        continue;
      }

      channelMessages[channel] = message.id;
    }

    return { conversations, messages: channelMessages };
  }

  /**
   * Create an awareness task if needed based on lead stage
   */
  async createAwarenessTaskIfNeeded(params: {
    leadData: any;
    siteId: string;
    userId: string;
    conversationId: string | null;
    commandIds?: { sales?: string; copywriter?: string };
  }): Promise<string | null> {
    const { leadData, siteId, userId, conversationId, commandIds } = params;
    try {
      const leadStage = leadData?.status?.toLowerCase() || leadData?.stage?.toLowerCase() || 'unknown';
      const earlyStages = ['new', 'cold', 'unqualified', 'awareness', 'interest', 'consideration', 'unknown'];
      
      if (!earlyStages.includes(leadStage)) return null;

      // Check for existing awareness task
      if (leadData?.id) {
        const { data: existingTasks } = await supabaseAdmin
          .from('tasks')
          .select('id')
          .eq('lead_id', leadData.id)
          .eq('type', 'awareness')
          .eq('site_id', siteId)
          .limit(1);
          
        if (existingTasks && existingTasks.length > 0) return existingTasks[0].id;
      }

      const leadName = leadData?.name || leadData?.email || 'Unknown Lead';
      const taskTitle = `Lead Awareness Follow-up: ${leadName}`;
      
      let taskDescription = `Follow-up task created for lead ${leadName}`;
      const hasCompanyData = leadData?.company && (typeof leadData.company === 'string' ? leadData.company.trim() !== '' : Object.keys(leadData.company).length > 0);
      
      if (hasCompanyData) {
        const companyInfo = safeStringify(leadData.company);
        if (companyInfo && companyInfo !== 'Not provided' && companyInfo !== '{}') {
          taskDescription += ` from ${companyInfo}`;
        }
      }
      
      taskDescription += `.\n\nLead Stage: ${leadStage}`;
      if (leadData?.email) taskDescription += `\nEmail: ${leadData.email}`;
      if (leadData?.phone) taskDescription += `\nPhone: ${leadData.phone}`;
      
      taskDescription += `\n\nThis task was automatically created as part of the lead follow-up sequence.`;
      if (conversationId) taskDescription += `\n\nRelated conversation: ${conversationId}`;

      let effectiveCommandId: string | undefined = undefined;
      if (commandIds?.sales && isValidUUID(commandIds.sales)) {
        effectiveCommandId = commandIds.sales;
      } else if (commandIds?.copywriter && isValidUUID(commandIds.copywriter)) {
        effectiveCommandId = commandIds.copywriter;
      }

      const taskData = {
        title: taskTitle,
        description: taskDescription,
        type: 'awareness',
        status: 'pending',
        stage: 'awareness',
        priority: 2,
        user_id: userId,
        site_id: siteId,
        lead_id: leadData?.id || undefined,
        conversation_id: conversationId || undefined,
        command_id: effectiveCommandId,
        notes: `Auto-generated from lead follow-up sequence.`,
        scheduled_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      };

      const task = await createTask(taskData);
      return task.id;
    } catch (error) {
      console.error('Error in createAwarenessTaskIfNeeded:', error);
      return null;
    }
  }
}

export const leadFollowUpLogService = new LeadFollowUpLogService();
