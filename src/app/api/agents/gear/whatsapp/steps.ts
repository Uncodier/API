'use step';

import { WhatsAppSendService } from '@/lib/services/whatsapp/WhatsAppSendService';
import { formatMarkdownForWhatsApp } from '@/lib/utils/whatsapp-formatter';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { executeAssistant } from '@/lib/services/robot-instance/assistant-executor';
import { createAccountTool, verifyAccountTool } from './tools';
import { instanceProjectTool } from '@/app/api/agents/tools/instance_project/assistantProtocol';
import { normalizePhoneForStorage } from '@/lib/utils/phone-normalizer';

import { OpenAIAgentExecutor } from '@/lib/custom-automation/openai-agent-executor';

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
        const fallbackName = `WhatsApp Lead (${phoneNumber.substring(0, 5)}***)`;
        const leadName = profileName ? `${profileName} (WhatsApp)` : fallbackName;
        
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
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
      
    if (existingConversation) {
      convId = existingConversation.id;
    } else {
      const fallbackTitle = `Gear Lead WhatsApp: ${phoneNumber.substring(0, 5)}***`;
      const title = profileName ? `Gear Lead WhatsApp: ${profileName}` : fallbackTitle;
      
      const convData: any = {
        lead_id: leadId,
        site_id: siteId,
        status: 'active',
        title: title,
        custom_data: { source: 'whatsapp', whatsapp_phone: phoneNumber, business_account_id: businessAccountId }
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
      status: 'received',
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
    if (userId) {
      const normalizedForTool = normalizePhoneForStorage(phoneNumber) || phoneNumber.trim();
      customTools.push(instanceProjectTool(userId, normalizedForTool));
    }
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
        status: 'sent',
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

function chunkMessage(text: string, maxLength = 1500): string[] {
  if (text.length <= maxLength) return [text];
  
  const chunks: string[] = [];
  let currentChunk = '';
  
  const paragraphs = text.split('\n\n');
  
  for (const paragraph of paragraphs) {
    if ((currentChunk ? currentChunk + '\n\n' + paragraph : paragraph).length <= maxLength) {
      currentChunk = currentChunk ? currentChunk + '\n\n' + paragraph : paragraph;
    } else {
      if (currentChunk.length > 0) {
        chunks.push(currentChunk);
        currentChunk = '';
      }
      
      if (paragraph.length > maxLength) {
        const lines = paragraph.split('\n');
        for (const line of lines) {
          if ((currentChunk ? currentChunk + '\n' + line : line).length <= maxLength) {
            currentChunk = currentChunk ? currentChunk + '\n' + line : line;
          } else {
            if (currentChunk.length > 0) {
              chunks.push(currentChunk);
              currentChunk = '';
            }
            if (line.length > maxLength) {
              let remaining = line;
              while (remaining.length > 0) {
                chunks.push(remaining.substring(0, maxLength));
                remaining = remaining.substring(maxLength);
              }
            } else {
              currentChunk = line;
            }
          }
        }
      } else {
        currentChunk = paragraph;
      }
    }
  }
  
  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }
  
  return chunks;
}

export async function sendWhatsAppResponse(
  userPhone: string,
  message: string,
  siteId: string,
  mediaUrls?: string[]
) {
  'use step';
  
  const formattedMessage = formatMarkdownForWhatsApp(message);
  const chunks = chunkMessage(formattedMessage, 1500);
  
  let allSuccess = true;
  
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    
    if (chunks.length > 1) {
      console.log(`[GearAgent] Sending chunk ${i + 1} of ${chunks.length} to WhatsApp: ${userPhone}`);
    } else {
      console.log(`[GearAgent] Sending response to WhatsApp: ${userPhone}`);
    }
    
    // Custom Twilio variables for this special Gear Agent
    const accountSid = process.env.GEAR_TWILIO_ACCOUNT_SID;
    const authToken = process.env.GEAR_TWILIO_AUTH_TOKEN;
    const fromNumber = process.env.GEAR_TWILIO_PHONE_NUMBER;
    
    // Verify that credentials are not default placeholders
    const hasValidCustomCredentials = 
      accountSid && 
      authToken && 
      fromNumber && 
      !accountSid.includes('tu_account') &&
      !authToken.includes('tu_auth') &&
      !fromNumber.includes('tu_numero');
    
    let chunkSent = false;
    
    if (hasValidCustomCredentials) {
      if (i === 0) {
        console.log(`[GearAgent] Using custom Twilio credentials (From: ${fromNumber}) to send message to ${userPhone}`);
      }
      try {
        const apiUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
        const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
        
        const formData = new URLSearchParams();
        // Ensure fromNumber doesn't already have whatsapp: and phone doesn't have it
        const cleanFrom = fromNumber.replace('whatsapp:', '');
        const cleanTo = userPhone.replace('whatsapp:', '');
        
        formData.append('From', `whatsapp:${cleanFrom}`);
        formData.append('To', `whatsapp:${cleanTo}`);
        formData.append('Body', chunk);
        
        // Add media URLs if present (only on the first chunk)
        if (i === 0 && mediaUrls && mediaUrls.length > 0) {
          const urlsToAttach = mediaUrls.slice(0, 10);
          urlsToAttach.forEach(url => {
            formData.append('MediaUrl', url);
          });
        }
        
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
          console.error(`[GearAgent] Twilio API Error for chunk ${i + 1}:`, errorData);
          console.warn(`[GearAgent] Custom Twilio setup failed for chunk ${i + 1}, falling back to platform service`);
        } else {
          console.log(`[GearAgent] Chunk ${i + 1} sent successfully via custom Twilio setup`);
          chunkSent = true;
        }
      } catch (error) {
        console.error(`[GearAgent] Exception sending chunk ${i + 1} via custom Twilio setup:`, error);
        console.warn(`[GearAgent] Custom Twilio setup threw exception for chunk ${i + 1}, falling back to platform service`);
      }
    }

    if (!chunkSent) {
      // Fallback to standard platform service
      console.log(`[GearAgent] Using platform WhatsAppSendService for chunk ${i + 1}`);
      try {
        await WhatsAppSendService.sendMessage({
          phone_number: userPhone,
          message: chunk,
          site_id: siteId,
          responseWindowEnabled: true,
          media_urls: i === 0 ? mediaUrls : undefined // Add media only to the first chunk
        });

        console.log(`[GearAgent] Chunk ${i + 1} sent successfully via platform WhatsAppSendService`);
        chunkSent = true;
      } catch (error) {
        console.error(`[GearAgent] Failed to send chunk ${i + 1} via platform WhatsAppSendService:`, error);
      }
    }
    
    if (!chunkSent) {
      allSuccess = false;
    }
    
    // Small delay between chunks to ensure arrival order in WhatsApp
    if (chunks.length > 1 && i < chunks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  
  return allSuccess;
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
