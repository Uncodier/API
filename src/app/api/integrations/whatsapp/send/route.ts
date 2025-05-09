import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';

// Util function to validate UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * Send a WhatsApp message using the Cloud API
 * @param phoneNumber The recipient's phone number with country code (no + or spaces)
 * @param message The message content
 * @param businessAccountId The WhatsApp Business Account ID
 * @returns Object with success status and details
 */
async function sendWhatsAppMessage(
  phoneNumber: string,
  message: string,
  businessAccountId: string
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    console.log(`📤 Enviando mensaje de WhatsApp a ${phoneNumber.substring(0, 5)}***`);
    
    // Get WhatsApp credentials from environment variables
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || businessAccountId;
    const accessToken = process.env.WHATSAPP_API_TOKEN;
    
    if (!accessToken) {
      console.error('❌ WHATSAPP_API_TOKEN no está configurado en las variables de entorno');
      return { success: false, error: 'API token not configured' };
    }
    
    // Prepare the request to the WhatsApp Business API
    const apiUrl = `https://graph.facebook.com/v17.0/${phoneNumberId}/messages`;
    
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phoneNumber,
        type: 'text',
        text: {
          body: message,
        },
      }),
    });
    
    // Check the response
    if (!response.ok) {
      const errorData = await response.json();
      console.error('❌ Error al enviar mensaje de WhatsApp:', errorData);
      return { 
        success: false, 
        error: `WhatsApp API error: ${errorData.error?.message || response.statusText}` 
      };
    }
    
    // Parse the successful response
    const responseData = await response.json();
    
    console.log(`✅ Mensaje de WhatsApp enviado exitosamente:`, responseData);
    
    return { 
      success: true, 
      messageId: responseData.messages?.[0]?.id 
    };
    
  } catch (error) {
    console.error('❌ Error al enviar mensaje de WhatsApp:', error);
    return { 
      success: false, 
      error: `Exception: ${(error as Error).message}` 
    };
  }
}

/**
 * API endpoint for sending WhatsApp messages
 */
export async function POST(request: NextRequest) {
  try {
    // Parse request body
    const body = await request.json();
    
    // Extract required fields
    const { phone_number, message, conversation_id, message_id, business_account_id } = body;
    
    // Validate required fields
    if (!phone_number) {
      return NextResponse.json({
        success: false,
        error: 'Missing required field: phone_number'
      }, { status: 400 });
    }
    
    if (!message) {
      return NextResponse.json({
        success: false,
        error: 'Missing required field: message'
      }, { status: 400 });
    }
    
    // Extract business account ID from the request or use default
    const businessAccountId = business_account_id || process.env.WHATSAPP_PHONE_NUMBER_ID;
    
    if (!businessAccountId) {
      return NextResponse.json({
        success: false,
        error: 'No WhatsApp Business Account ID provided'
      }, { status: 400 });
    }
    
    // Send the message via WhatsApp API
    const result = await sendWhatsAppMessage(phone_number, message, businessAccountId);
    
    if (!result.success) {
      return NextResponse.json({
        success: false,
        error: result.error
      }, { status: 500 });
    }
    
    // If conversation_id and message_id are provided, save the message to our database
    if (conversation_id && isValidUUID(conversation_id)) {
      console.log(`💾 Guardando mensaje en la base de datos para conversación: ${conversation_id}`);
      
      try {
        // Find the conversation
        const { data: conversation, error: convError } = await supabaseAdmin
          .from('conversations')
          .select('id, visitor_id, site_id, agent_id')
          .eq('id', conversation_id)
          .single();
        
        if (convError) {
          console.error('❌ Error al obtener la conversación:', convError);
        } else if (conversation) {
          // Save the message with reference to conversation
          const { data: savedMessage, error: msgError } = await supabaseAdmin
            .from('messages')
            .insert([
              {
                conversation_id: conversation_id,
                content: message,
                sender_type: 'assistant', // or 'agent' depending on your schema
                custom_data: {
                  source: 'whatsapp',
                  whatsapp_message_id: result.messageId,
                  whatsapp_phone: phone_number,
                  reference_message_id: message_id
                }
              }
            ])
            .select()
            .single();
          
          if (msgError) {
            console.error('❌ Error al guardar el mensaje en la base de datos:', msgError);
          } else {
            console.log(`✅ Mensaje guardado con ID: ${savedMessage.id}`);
          }
        }
      } catch (dbError) {
        console.error('❌ Error de base de datos al guardar el mensaje:', dbError);
      }
    }
    
    // Return success response
    return NextResponse.json({
      success: true,
      message_id: result.messageId
    }, { status: 200 });
    
  } catch (error) {
    console.error('❌ Error en el endpoint de envío de WhatsApp:', error);
    return NextResponse.json({
      success: false,
      error: 'Internal server error'
    }, { status: 500 });
  }
} 