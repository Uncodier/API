import { NextResponse } from 'next/server';
import { 
  getLeadInfo
} from '@/lib/helpers/lead-context-helper';
import { leadFollowUpLogService } from '@/lib/services/lead-followup/LeadFollowUpLogService';
import { supabaseAdmin } from '@/lib/database/supabase-client';

/**
 * Validates if a string is a valid UUID
 */
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Generic function to find an active agent by role (kept for internal use if needed, but mostly logic moved to service)
async function findActiveAgentByRole(siteId: string, role: string): Promise<{agentId: string, userId: string} | null> {
  try {
    if (!siteId || !isValidUUID(siteId)) return null;
    
    const { data, error } = await supabaseAdmin
      .from('agents')
      .select('id, user_id')
      .eq('site_id', siteId)
      .eq('role', role)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1);
    
    if (error || !data || data.length === 0) return null;
    
    return {
      agentId: data[0].id,
      userId: data[0].user_id
    };
  } catch (error) {
    return null;
  }
}

async function findActiveSalesAgent(siteId: string): Promise<{agentId: string, userId: string} | null> {
  return await findActiveAgentByRole(siteId, 'Sales/CRM Specialist');
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    console.log('[LeadFollowUp:Log] Received body keys:', Object.keys(body));
    
    const { 
      siteId, 
      leadId, 
      userId, 
      agent_id,
      leadData,
      messages,
      command_ids,
      message_status
    } = body;
    
    if (!siteId || !leadId || !userId) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'siteId, leadId and userId are required' } },
        { status: 400 }
      );
    }

    const salesAgentResult = await findActiveSalesAgent(siteId);
    let effectiveAgentId = agent_id || salesAgentResult?.agentId;

    let effectiveLeadData = leadData;
    if (!effectiveLeadData || Object.keys(effectiveLeadData).length === 0) {
      effectiveLeadData = await getLeadInfo(leadId);
    }

    if (!effectiveLeadData) {
      return NextResponse.json(
        { success: false, error: { code: 'LEAD_NOT_FOUND', message: 'Lead information not found' } },
        { status: 404 }
      );
    }

    // Step 1: Create or Reuse conversations and create messages
    let channelResults: {conversations: Record<string, string>, messages: Record<string, string>} = {
      conversations: {},
      messages: {}
    };
    
    if (messages && typeof messages === 'object' && Object.keys(messages).length > 0) {
      channelResults = await leadFollowUpLogService.createChannelMessages({
        messages,
        leadData: effectiveLeadData,
        siteId,
        leadId,
        userId,
        agentId: effectiveAgentId,
        commandIds: command_ids,
        messageStatus: message_status
      });
    }

    // Step 2: Create awareness task if needed
    const firstConversationId = Object.values(channelResults.conversations)[0] || null;
    const awarenessTaskId = await leadFollowUpLogService.createAwarenessTaskIfNeeded({
      leadData: effectiveLeadData,
      siteId,
      userId,
      conversationId: firstConversationId,
      commandIds: command_ids
    });

    return NextResponse.json({
      success: true,
      data: {
        conversation_ids: Object.values(channelResults.conversations),
        message_ids: Object.values(channelResults.messages),
        conversations_by_channel: channelResults.conversations,
        messages_by_channel: channelResults.messages,
        awareness_task_id: awarenessTaskId,
        lead: effectiveLeadData,
        agent_info: {
          agent_id: effectiveAgentId,
          agent_found: !!salesAgentResult,
          agent_role: salesAgentResult ? 'Sales/CRM Specialist' : 'Not found'
        },
        created_at: new Date().toISOString()
      }
    });
    
  } catch (error: any) {
    console.error('❌ Error in lead follow-up logs endpoint:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: { 
          code: 'SYSTEM_ERROR', 
          message: error.message || 'An internal system error occurred' 
        } 
      },
      { status: 500 }
    );
  }
}
