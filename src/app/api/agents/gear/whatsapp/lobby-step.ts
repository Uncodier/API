'use step';

import { supabaseAdmin } from '@/lib/database/supabase-client';
import { createAccountTool, verifyAccountTool } from './tools';
import { instanceProjectTool } from '@/app/api/agents/tools/instance_project/assistantProtocol';
import { normalizePhoneForStorage } from '@/lib/utils/phone-normalizer';
import { AIAgentExecutor, type Tool } from '@/lib/custom-automation/ai-agent-executor';
import { withExecutionRouting } from '@/lib/services/ai/customer-routing';

export async function processUnregisteredUserStep(
  phoneNumber: string,
  messageContent: string,
  businessAccountId: string,
  waMessageId: string | undefined,
  siteId: string,
  systemPrompt: string,
  userId?: string | null,
  profileName?: string
) {
  'use step';

  try {
    // Ya no creamos ni buscamos visitorId.
    // Vamos directo a Get or create lead.

    // Get or create lead
    let leadId: string | null = null;
    const phoneNorm = normalizePhoneForStorage(phoneNumber) || phoneNumber.trim();
    const { data: existingLead } = await supabaseAdmin
      .from('leads')
      .select('id')
      .eq('site_id', siteId)
      .eq('phone', phoneNorm)
      .maybeSingle();

    if (existingLead) {
      leadId = existingLead.id;
    } else {
      // Need site's owner user_id to create a lead
      const { data: siteData } = await supabaseAdmin
        .from('sites')
        .select('user_id')
        .eq('id', siteId)
        .single();

      if (siteData) {
        const fallbackName = `Lead: ${phoneNumber.substring(0, 5)}***`;
        const leadName = profileName ? profileName : fallbackName;

        const { data: newLead, error: leadError } = await supabaseAdmin
          .from('leads')
          .insert([{
            site_id: siteId,
            user_id: siteData.user_id,
            email: `${phoneNorm}@whatsapp.lead`, // Provide a mock email if required by schema but usually phone is enough if we handle it
            phone: phoneNorm,
            origin: 'whatsapp',
            status: 'new',
            name: leadName
          }])
          .select('id')
          .single();

        if (!leadError && newLead) {
          leadId = newLead.id;
        } else {
          console.error('❌ Error creating lead:', leadError);
          throw leadError; // Throw if lead fails because conversation might need it
        }
      } else {
        console.error('❌ Error creating lead: Site not found');
        throw new Error('Site not found for creating lead');
      }
    }

    // Get or create conversation (usando lead_id)
    let convId: string;
    const { data: existingConversation } = await supabaseAdmin
      .from('conversations')
      .select('id')
      .eq('lead_id', leadId)
      .eq('status', 'active')
      .eq('channel', 'whatsapp')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingConversation) {
      convId = existingConversation.id;
    } else {
      const fallbackTitle = `WhatsApp: ${phoneNumber.substring(0, 5)}***`;
      const title = profileName ? `WhatsApp: ${profileName}` : fallbackTitle;

      const convData: any = {
        lead_id: leadId,
        site_id: siteId,
        status: 'active',
        title: title,
        channel: 'whatsapp',
        custom_data: { source: 'whatsapp', channel: 'whatsapp', whatsapp_phone: phoneNumber, business_account_id: businessAccountId }
      };

      const { data: newConversation, error: convError } = await supabaseAdmin
        .from('conversations')
        .insert([convData])
        .select()
        .single();

      if (convError) {
        console.error('❌ Error creating conversation:', convError);
        throw convError;
      }

      convId = newConversation!.id;
    }

    // Save the user message (sin visitor_id)
    const { error: msgError, data: msgData } = await supabaseAdmin.from('messages').insert([{
      conversation_id: convId,
      content: messageContent,
      role: 'user',
      custom_data: { source: 'whatsapp', status: 'received', whatsapp_message_id: waMessageId, whatsapp_phone: phoneNumber },
      lead_id: leadId
    }]).select().single();

    if (msgError) console.error('❌ Error saving user message:', msgError);
    if (!msgError) console.log('✅ User message saved:', msgData.id);

    // Fetch conversation history for context
    const { data: pastMessages } = await supabaseAdmin
      .from('messages')
      .select('id, content, role')
      .eq('conversation_id', convId)
      .order('created_at', { ascending: true })
      .limit(20);

    const messages = (pastMessages || []).map(msg => ({
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: msg.content
    }));

    // Check if the current message is in pastMessages
    const hasCurrentMessage = pastMessages?.some(m => m.id === msgData?.id);
    if (!hasCurrentMessage && msgData) {
      messages.push({
        role: 'user',
        content: messageContent
      });
    }

    // 2. Run the assistant using AIAgentExecutor
    const customTools: Tool[] = [createAccountTool(), verifyAccountTool()];
    if (userId) {
      const normalizedForTool = normalizePhoneForStorage(phoneNumber) || phoneNumber.trim();
      customTools.push(instanceProjectTool(userId, normalizedForTool));
    }


    console.log(`[GearAgent] Executing assistant for whatsapp unregistered user (history size: ${messages.length})`);

    const executionResult = await withExecutionRouting({ payer: 'platform', siteId }, siteId, async () => {
      // Lobby identity does not authorize spending a customer connection.
      const executor = new AIAgentExecutor({ siteId });
      return executor.act({
      tools: customTools,
      system: systemPrompt,
      messages: messages as any[], // History included!
      maxIterations: 5, // Avoid long loops for unregistered users
      // No stream callbacks needed here for WhatsApp since it's asynchronous push
      });
    });

    const assistantResponse = executionResult.text;
    console.log(`[GearAgent] Assistant response generated (length: ${assistantResponse?.length || 0})`);

    // Si no hay respuesta, devolvemos un mensaje genérico por si acaso se quedó atrapado el agente
    if (!assistantResponse) {
       console.log(`[GearAgent] No text returned from agent executor, generating fallback message.`);
       return "I couldn't process your request right now. Please try again later.";
    }

    if (assistantResponse) {
      // Save assistant response
      const { data: savedMsg, error: saveError } = await supabaseAdmin.from('messages').insert([{
        conversation_id: convId,
        content: assistantResponse,
        role: 'assistant',
        custom_data: { source: 'whatsapp', status: 'sent', whatsapp_phone: phoneNumber },
        lead_id: leadId
      }]).select().single();

      if (saveError) console.error('❌ Error saving assistant response:', saveError);
      if (!saveError && savedMsg) console.log('✅ Assistant message saved:', savedMsg.id);
    }

    return assistantResponse;
  } catch (error: any) {
    console.error('❌ Error in processUnregisteredUserStep:', error);
    throw error;
  }
}
