'use step';

import { supabaseAdmin } from '@/lib/database/supabase-client';
import { AIAgentExecutor } from '@/lib/custom-automation/ai-agent-executor';
import { createAccountTool, verifyAccountTool } from '../whatsapp/tools';
import { instanceProjectTool } from '@/app/api/agents/tools/instance_project/assistantProtocol';
import { AgentMailSendService } from '@/lib/services/email/AgentMailSendService';

export async function processUnregisteredUserEmailStep(
  userEmail: string,
  messageContent: string,
  businessAccountId: string | undefined,
  messageId: string | undefined,
  siteId: string,
  systemPrompt: string,
  userId?: string | null,
  profileName?: string
) {
  'use step';
  
  try {
    // Get or create lead
    let leadId: string | null = null;
    const { data: existingLead } = await supabaseAdmin
      .from('leads')
      .select('id')
      .eq('site_id', siteId)
      .eq('email', userEmail.toLowerCase().trim())
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
        const fallbackName = `Lead: ${userEmail.split('@')[0]}`;
        const leadName = profileName ? profileName : fallbackName;
        
        const { data: newLead, error: leadError } = await supabaseAdmin
          .from('leads')
          .insert([{
            site_id: siteId,
            user_id: siteData.user_id,
            email: userEmail.toLowerCase().trim(),
            origin: 'email',
            status: 'new',
            name: leadName
          }])
          .select('id')
          .single();
          
        if (!leadError && newLead) {
          leadId = newLead.id;
        } else {
          console.error('❌ Error creating lead:', leadError);
          throw leadError;
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
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
      
    if (existingConversation) {
      convId = existingConversation.id;
    } else {
      const fallbackTitle = `Email: ${userEmail.split('@')[0]}`;
      const title = profileName ? `Email: ${profileName}` : fallbackTitle;
      
      const convData: any = {
        lead_id: leadId,
        site_id: siteId,
        status: 'active',
        title: title,
        custom_data: { source: 'email', email: userEmail, business_account_id: businessAccountId }
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
    const { error: msgError } = await supabaseAdmin.from('messages').insert([{
      conversation_id: convId,
      content: messageContent,
      role: 'user',
      custom_data: { source: 'email', email_message_id: messageId, email: userEmail, status: 'received' }
    }]);

    if (msgError) console.error('❌ Error saving user message:', msgError);

    // Fetch conversation history for context
    const { data: pastMessages } = await supabaseAdmin
      .from('messages')
      .select('content, role')
      .eq('conversation_id', convId)
      .order('created_at', { ascending: true })
      .limit(20);

    const messages = (pastMessages || []).map(msg => ({
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: msg.content
    }));

    // 2. Run the assistant using AIAgentExecutor
    const customTools = [createAccountTool(), verifyAccountTool()];
    if (userId) {
      customTools.push(instanceProjectTool(userId, userEmail));
    }
    const executor = new AIAgentExecutor();
    
    const executionResult = await executor.act({
      tools: customTools,
      system: systemPrompt,
      messages: messages as any[], // History included!
    });

    const assistantResponse = executionResult.text;

    if (assistantResponse) {
      // Save assistant response
      const { data: savedMsg, error: saveError } = await supabaseAdmin.from('messages').insert([{
        conversation_id: convId,
        content: assistantResponse,
        role: 'assistant',
        custom_data: { source: 'email', email: userEmail, status: 'sent' }
      }]).select().single();
      
      if (saveError) console.error('❌ Error saving assistant response:', saveError);
    }

    return assistantResponse;
  } catch (error: any) {
    console.error('❌ Error in processUnregisteredUserEmailStep:', error);
    throw error;
  }
}

export async function sendEmailResponse(
  userEmail: string,
  message: string,
  siteId: string
) {
  'use step';
  
  console.log(`[GearAgent] Sending response to Email: ${userEmail}`);

  try {
    const result = await AgentMailSendService.sendViaAgentMail({
      email: userEmail,
      subject: 'Re: Mensaje a Gear',
      message: message,
      site_id: siteId,
      username: 'gear',
      domain: 'makinari.email',
      senderEmail: 'gear@makinari.email'
    });

    if (result.success) {
      console.log(`[GearAgent] Email sent successfully via AgentMail to ${userEmail}`);
      return true;
    } else {
      console.error(`[GearAgent] Failed to send email via AgentMail:`, result);
      return false;
    }
  } catch (error) {
    console.error(`[GearAgent] Exception sending email response:`, error);
    return false;
  }
}

export async function sendEmailError(
  userEmail: string,
  siteId: string
) {
  'use step';
  
  try {
    return await sendEmailResponse(
      userEmail, 
      "I'm sorry, I encountered an error processing your request.", 
      siteId
    );
  } catch (sendError) {
    console.error(`[GearAgent] Failed to send error email:`, sendError);
    return false;
  }
}
