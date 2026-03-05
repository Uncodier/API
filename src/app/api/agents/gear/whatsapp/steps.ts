'use step';

import { WhatsAppSendService } from '@/lib/services/whatsapp/WhatsAppSendService';
import { formatMarkdownForWhatsApp } from '@/lib/utils/whatsapp-formatter';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import crypto from 'crypto';
import { executeAssistant } from '@/lib/services/robot-instance/assistant-executor';
import { createAccountTool, verifyAccountTool } from './tools';
import { normalizePhoneForStorage } from '@/lib/utils/phone-normalizer';

import { OpenAIAgentExecutor } from '@/lib/custom-automation/openai-agent-executor';

export async function processUnregisteredUserStep(
  phoneNumber: string,
  messageContent: string,
  businessAccountId: string,
  waMessageId: string | undefined,
  siteId: string,
  systemPrompt: string
) {
  'use step';
  
  try {
    // 1. Save visitor, conversation and message
    const visitorIdHash = crypto
      .createHash('sha256')
      .update(`whatsapp:${phoneNumber}:${businessAccountId}`)
      .digest('hex');
    
    const visitorId = `whatsapp_${visitorIdHash.substring(0, 16)}`;
    
    // Check if visitor exists
    const { data: existingVisitor, error: visitorError } = await supabaseAdmin
      .from('visitors')
      .select('id')
      .eq('id', visitorId)
      .maybeSingle();
      
    if (!existingVisitor) {
      await supabaseAdmin.from('visitors').insert([{
        id: visitorId,
        site_id: siteId,
        source: 'whatsapp',
        platform: 'mobile',
        custom_data: { whatsapp_phone: phoneNumber, business_account_id: businessAccountId }
      }]);
    }

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
        const { data: newLead, error: leadError } = await supabaseAdmin
          .from('leads')
          .insert([{
            site_id: siteId,
            user_id: siteData.user_id,
            email: '', // Required by schema
            phone: phoneNorm,
            origin: 'whatsapp',
            status: 'new',
            name: `WhatsApp Lead (${phoneNumber.substring(0, 5)}***)`
          }])
          .select('id')
          .single();
          
        if (!leadError && newLead) {
          leadId = newLead.id;
        } else {
          console.error('❌ Error creating lead:', leadError);
        }
      } else {
        console.error('❌ Error creating lead: Site not found');
      }
    }

    // Get or create conversation
    let convId: string;
    const { data: existingConversation } = await supabaseAdmin
      .from('conversations')
      .select('id')
      .eq('visitor_id', visitorId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
      
    if (existingConversation) {
      convId = existingConversation.id;
    } else {
      const convData: any = {
        visitor_id: visitorId,
        site_id: siteId,
        status: 'active',
        title: `Gear Lead WhatsApp: ${phoneNumber.substring(0, 5)}***`,
        custom_data: { source: 'whatsapp', whatsapp_phone: phoneNumber, business_account_id: businessAccountId }
      };
      if (leadId) convData.lead_id = leadId;

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
    
    // Save the user message
    const { error: msgError } = await supabaseAdmin.from('messages').insert([{
      conversation_id: convId,
      visitor_id: visitorId,
      content: messageContent,
      role: 'user',
      custom_data: { source: 'whatsapp', whatsapp_message_id: waMessageId, whatsapp_phone: phoneNumber }
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

    // 2. Run the assistant using OpenAIAgentExecutor
    const customTools = [createAccountTool(), verifyAccountTool()];
    const executor = new OpenAIAgentExecutor();
    
    const executionResult = await executor.act({
      tools: customTools,
      system: systemPrompt,
      messages: messages as any[], // History included!
      // No stream callbacks needed here for WhatsApp since it's asynchronous push
    });

    const assistantResponse = executionResult.text;

    if (assistantResponse) {
      // Save assistant response
      const { data: savedMsg, error: saveError } = await supabaseAdmin.from('messages').insert([{
        conversation_id: convId,
        content: assistantResponse,
        role: 'assistant',
        custom_data: { source: 'whatsapp', whatsapp_phone: phoneNumber }
      }]).select().single();
      
      if (saveError) console.error('❌ Error saving assistant response:', saveError);
    }

    return assistantResponse;
  } catch (error: any) {
    console.error('❌ Error in processUnregisteredUserStep:', error);
    return null;
  }
}

export async function sendWhatsAppTypingIndicator(
  messageSid: string,
  siteId: string
) {
  'use step';
  
  if (!messageSid) return false;
  
  console.log(`[GearAgent] Sending typing indicator for message ${messageSid}`);
  
  const accountSid = process.env.GEAR_TWILIO_ACCOUNT_SID;
  const authToken = process.env.GEAR_TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.GEAR_TWILIO_PHONE_NUMBER;
  
  const hasValidCustomCredentials = 
    accountSid && 
    authToken && 
    fromNumber && 
    !accountSid.includes('tu_account') &&
    !authToken.includes('tu_auth') &&
    !fromNumber.includes('tu_numero');
    
  if (hasValidCustomCredentials) {
    try {
      const apiUrl = `https://messaging.twilio.com/v2/Indicators/Typing.json`;
      const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
      
      const formData = new URLSearchParams();
      formData.append('messageId', messageSid);
      formData.append('channel', 'whatsapp');
      
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData.toString()
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        console.warn(`[GearAgent] Failed to send typing indicator:`, errorData);
        return false;
      }
      
      console.log(`[GearAgent] Typing indicator sent successfully`);
      return true;
    } catch (error) {
      console.warn(`[GearAgent] Exception sending typing indicator:`, error);
      return false;
    }
  }
  
  // Si no hay credenciales custom, intentamos obtenerlas del sitio
  try {
    const config = await WhatsAppSendService.getWhatsAppConfig(siteId);
    if (config && config.phoneNumberId && config.accessToken) {
      const apiUrl = `https://messaging.twilio.com/v2/Indicators/Typing.json`;
      const credentials = Buffer.from(`${config.phoneNumberId}:${config.accessToken}`).toString('base64');
      
      const formData = new URLSearchParams();
      formData.append('messageId', messageSid);
      formData.append('channel', 'whatsapp');
      
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData.toString()
      });
      
      if (response.ok) {
        console.log(`[GearAgent] Typing indicator sent successfully via platform settings`);
        return true;
      }
    }
  } catch (err) {
    console.warn(`[GearAgent] Could not send typing indicator via platform settings`);
  }
  
  return false;
}

export async function sendWhatsAppResponse(
  userPhone: string,
  message: string,
  siteId: string
) {
  'use step';
  
  const formattedMessage = formatMarkdownForWhatsApp(message);
  
  console.log(`[GearAgent] Sending response to WhatsApp: ${userPhone}`);
  
  // Custom Twilio variables for this special Gear Agent
  const accountSid = process.env.GEAR_TWILIO_ACCOUNT_SID;
  const authToken = process.env.GEAR_TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.GEAR_TWILIO_PHONE_NUMBER;
  
  // Verificamos que las credenciales no sean los placeholders por defecto
  const hasValidCustomCredentials = 
    accountSid && 
    authToken && 
    fromNumber && 
    !accountSid.includes('tu_account') &&
    !authToken.includes('tu_auth') &&
    !fromNumber.includes('tu_numero');
  
  if (hasValidCustomCredentials) {
    console.log(`[GearAgent] Using custom Twilio credentials (From: ${fromNumber}) to send message to ${userPhone}`);
    try {
      const apiUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
      const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
      
      const formData = new URLSearchParams();
      // Ensure fromNumber doesn't already have whatsapp: and phone doesn't have it
      const cleanFrom = fromNumber.replace('whatsapp:', '');
      const cleanTo = userPhone.replace('whatsapp:', '');
      
      formData.append('From', `whatsapp:${cleanFrom}`);
      formData.append('To', `whatsapp:${cleanTo}`);
      formData.append('Body', formattedMessage);
      
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData.toString()
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        console.error(`[GearAgent] Twilio API Error:`, errorData);
        // Let it fall back to standard service instead of returning false immediately
        console.warn(`[GearAgent] Custom Twilio setup failed, falling back to platform service`);
      } else {
        console.log(`[GearAgent] Response sent to WhatsApp successfully via custom Twilio setup`);
        return true;
      }
    } catch (error) {
      console.error(`[GearAgent] Exception sending via custom Twilio setup:`, error);
      console.warn(`[GearAgent] Custom Twilio setup threw exception, falling back to platform service`);
    }
  }

  // Fallback to standard platform service
  console.log(`[GearAgent] Using platform WhatsAppSendService`);
  try {
    await WhatsAppSendService.sendMessage({
      phone_number: userPhone,
      message: formattedMessage,
      site_id: siteId,
      responseWindowEnabled: true
    });

    console.log(`[GearAgent] Response sent to WhatsApp successfully`);
    return true;
  } catch (error) {
    console.error(`[GearAgent] Failed to send via platform WhatsAppSendService:`, error);
    return false;
  }
}

export async function sendWhatsAppError(
  userPhone: string,
  siteId: string
) {
  'use step';
  
  try {
    // Re-use the send logic to also support custom Twilio for errors
    return await sendWhatsAppResponse(
      userPhone, 
      "I'm sorry, I encountered an error processing your request.", 
      siteId
    );
  } catch (sendError) {
    console.error(`[GearAgent] Failed to send error message:`, sendError);
    return false;
  }
}
