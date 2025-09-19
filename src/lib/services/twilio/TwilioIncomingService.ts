import { supabaseAdmin } from '@/lib/database/supabase-client';
import { WorkflowService } from '@/lib/services/workflow-service';

export interface TwilioWhatsAppWebhook {
  MessageSid: string;
  AccountSid: string;
  MessagingServiceSid?: string;
  From: string; // whatsapp:+1234567890
  To: string;   // whatsapp:+1234567890
  Body: string;
  NumMedia?: string;
  MediaUrl0?: string;
  MediaContentType0?: string;
  SmsMessageSid?: string;
  SmsStatus?: string;
  SmsSid?: string;
  WaId?: string;
  ProfileName?: string;
  ButtonText?: string;
  ButtonPayload?: string;
}

function extractPhoneNumber(twilioPhoneFormat: string): string {
  return twilioPhoneFormat.replace('whatsapp:', '');
}

export async function getUserIdFromSite(siteId: string): Promise<string | null> {
  try {
    const { data: site, error } = await supabaseAdmin
      .from('sites')
      .select('user_id')
      .eq('id', siteId)
      .single();
    if (error) return null;
    return site?.user_id || null;
  } catch {
    return null;
  }
}

export async function findExistingLead(siteId: string, phoneVariants: string[]): Promise<string | null> {
  try {
    let query = supabaseAdmin
      .from('leads')
      .select('id')
      .eq('site_id', siteId);
    if (phoneVariants.length > 1) {
      const phoneQueries = phoneVariants.map(variant => `phone.eq.${variant}`);
      query = query.or(phoneQueries.join(','));
    } else if (phoneVariants.length === 1) {
      query = query.eq('phone', phoneVariants[0]);
    }
    const { data: lead, error } = await query.single();
    if (error && error.code !== 'PGRST116') return null;
    return lead?.id || null;
  } catch {
    return null;
  }
}

export async function findWhatsAppConversation(leadId: string): Promise<string | null> {
  try {
    const { data: conversation, error } = await supabaseAdmin
      .from('conversations')
      .select('id')
      .eq('lead_id', leadId)
      .eq('status', 'active')
      .contains('custom_data', { channel: 'whatsapp' })
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    if (error && error.code !== 'PGRST116') return null;
    return conversation?.id || null;
  } catch {
    return null;
  }
}

export async function findWhatsAppConfiguration(businessPhoneNumber: string): Promise<{
  success: boolean;
  siteId?: string;
  agentId?: string;
  error?: string;
}> {
  try {
    const { data: tokens, error } = await supabaseAdmin
      .from('secure_tokens')
      .select('*')
      .eq('token_type', 'twilio_whatsapp')
      .like('identifier', `%${businessPhoneNumber}%`);
    if (error) {
      return { success: false, error: `Database error: ${error.message}` };
    }
    if (!tokens || tokens.length === 0) {
      return { success: false, error: `No WhatsApp configuration found for business number ${businessPhoneNumber}` };
    }
    const tokenRecord = tokens[0];
    const siteId = tokenRecord.site_id;
    if (!siteId) return { success: false, error: 'No site_id found in WhatsApp configuration' };

    let agentId: string | undefined;
    if (tokenRecord.metadata && typeof tokenRecord.metadata === 'object') {
      agentId = tokenRecord.metadata.agent_id;
    }
    if (!agentId) {
      const { data: customerSupportAgent } = await supabaseAdmin
        .from('agents')
        .select('id')
        .eq('site_id', siteId)
        .eq('status', 'active')
        .contains('configuration', { role: 'Customer Support' })
        .limit(1)
        .single();
      if (customerSupportAgent) {
        agentId = customerSupportAgent.id;
      } else {
        const { data: fallbackAgent } = await supabaseAdmin
          .from('agents')
          .select('id')
          .eq('site_id', siteId)
          .eq('status', 'active')
          .limit(1)
          .single();
        if (fallbackAgent) agentId = fallbackAgent.id;
      }
    }
    if (!agentId) return { success: false, error: `No active agent found for site ${siteId}` };
    return { success: true, siteId, agentId };
  } catch (error) {
    return { success: false, error: `Error finding WhatsApp configuration: ${error instanceof Error ? error.message : 'Unknown error'}` };
  }
}

export async function processIncomingMessage(
  webhookData: TwilioWhatsAppWebhook,
  siteId: string,
  agentId: string
): Promise<{ success: boolean; workflowId?: string; error?: string }> {
  try {
    const workflowService = WorkflowService.getInstance();
    const userId = await getUserIdFromSite(siteId);
    if (!userId) {
      return { success: false, error: 'Failed to resolve user_id for site' };
    }
    const phoneNumber = extractPhoneNumber(webhookData.From);
    const messageContent = webhookData.Body;
    const messageId = webhookData.MessageSid;
    const businessAccountId = webhookData.AccountSid;
    const senderName = webhookData.ProfileName || 'WhatsApp User';

    // Try to link to existing lead/conversation if any
    let conversationId: string | null = null;
    try {
      const { normalizePhoneForSearch } = await import('@/lib/utils/phone-normalizer');
      const phoneVariants = normalizePhoneForSearch(phoneNumber);
      const leadId = await findExistingLead(siteId, phoneVariants);
      if (leadId) {
        conversationId = await findWhatsAppConversation(leadId);
      }
    } catch {}

    const workflowResult = await workflowService.answerWhatsappMessage({
      phoneNumber,
      messageContent,
      businessAccountId,
      messageId,
      conversationId: conversationId || null,
      agentId,
      siteId,
      userId,
      senderName,
    });

    if (workflowResult.success) {
      return { success: true, workflowId: workflowResult.workflowId };
    }
    return { success: false, error: workflowResult.error?.message || 'Unknown error' };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}


