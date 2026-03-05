'use step';

import { WhatsAppSendService } from '@/lib/services/whatsapp/WhatsAppSendService';

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
      formData.append('Body', message);
      
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
      message: message,
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
