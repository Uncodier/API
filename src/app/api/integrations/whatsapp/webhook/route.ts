import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

// Util function to validate UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Process a media message from WhatsApp
async function processMediaMessage(
  mediaObject: any,
  messageId: string,
  phoneNumber: string,
  businessAccountId: string
): Promise<string | null> {
  try {
    console.log(`📷 Procesando mensaje con media de tipo ${mediaObject.type}`);
    
    // Store media metadata in Supabase and return content with media reference
    const mediaId = `whatsapp_media_${messageId}`;
    
    // Media types: image, video, audio, document, sticker...
    let mediaContent = `[${mediaObject.type}]`;
    
    if (mediaObject.caption) {
      mediaContent += `: ${mediaObject.caption}`;
    }
    
    // TODO: Implement media download if required
    // Requires access to WhatsApp Business API or Meta Graph API with appropriate tokens
    
    return mediaContent;
  } catch (error) {
    console.error('❌ Error al procesar mensaje con media:', error);
    return null;
  }
}

// Save a WhatsApp message to the database
async function saveWhatsAppMessage(
  phoneNumber: string,
  content: string,
  businessAccountId: string,
  waMessageId: string,
  conversationId?: string,
  agentId?: string,
  siteId?: string
): Promise<{ conversationId: string; messageId: string } | null> {
  try {
    // Generate a visitor_id based on the phone number if not exists
    const visitorIdHash = crypto
      .createHash('sha256')
      .update(`whatsapp:${phoneNumber}:${businessAccountId}`)
      .digest('hex');
    
    const visitorId = `whatsapp_${visitorIdHash.substring(0, 16)}`;
    
    console.log(`📱 Procesando mensaje de WhatsApp para visitante ${visitorId} (teléfono ${phoneNumber.substring(0, 5)}***)`);
    
    // Check if visitor exists or create
    const { data: existingVisitor, error: visitorError } = await supabaseAdmin
      .from('visitors')
      .select('id')
      .eq('id', visitorId)
      .single();
    
    if (visitorError && visitorError.code !== 'PGRST116') {
      // PGRST116 is "no rows returned" which is expected if visitor doesn't exist
      console.error('❌ Error al verificar visitante:', visitorError);
      return null;
    }
    
    if (!existingVisitor) {
      // Create visitor if not exists
      const { error: createVisitorError } = await supabaseAdmin
        .from('visitors')
        .insert([
          {
            id: visitorId,
            site_id: siteId,
            source: 'whatsapp',
            platform: 'mobile',
            custom_data: {
              whatsapp_phone: phoneNumber,
              business_account_id: businessAccountId,
            }
          }
        ]);
      
      if (createVisitorError) {
        console.error('❌ Error al crear visitante:', createVisitorError);
        return null;
      }
      
      console.log(`✅ Visitante creado: ${visitorId}`);
    }
    
    // Get or create conversation
    let convId = conversationId || '';
    if (!convId || !isValidUUID(convId)) {
      // Look for an existing active conversation for this visitor
      const { data: existingConversation, error: convError } = await supabaseAdmin
        .from('conversations')
        .select('id')
        .eq('visitor_id', visitorId)
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      
      if (convError && convError.code !== 'PGRST116') {
        console.error('❌ Error al buscar conversación existente:', convError);
        return null;
      }
      
      if (existingConversation) {
        convId = existingConversation.id;
        console.log(`🔄 Utilizando conversación existente: ${convId}`);
      } else {
        // Create new conversation
        const { data: newConversation, error: createConvError } = await supabaseAdmin
          .from('conversations')
          .insert([
            {
              visitor_id: visitorId,
              site_id: siteId,
              agent_id: agentId,
              status: 'active',
              title: `Conversación WhatsApp: ${phoneNumber.substring(0, 5)}***`,
              custom_data: {
                source: 'whatsapp',
                whatsapp_phone: phoneNumber,
                business_account_id: businessAccountId
              }
            }
          ])
          .select()
          .single();
        
        if (createConvError) {
          console.error('❌ Error al crear conversación:', createConvError);
          return null;
        }
        
        convId = newConversation.id;
        console.log(`✅ Nueva conversación creada: ${convId}`);
      }
    }
    
    // Save the message
    const { data: savedMessage, error: msgError } = await supabaseAdmin
      .from('messages')
      .insert([
        {
          conversation_id: convId,
          visitor_id: visitorId,
          content: content,
          sender_type: 'visitor',
          custom_data: {
            source: 'whatsapp',
            whatsapp_message_id: waMessageId,
            whatsapp_phone: phoneNumber
          }
        }
      ])
      .select()
      .single();
    
    if (msgError) {
      console.error('❌ Error al guardar mensaje:', msgError);
      return null;
    }
    
    console.log(`💾 Mensaje guardado con ID: ${savedMessage.id}`);
    
    return { conversationId: convId, messageId: savedMessage.id };
  } catch (error) {
    console.error('❌ Error al procesar mensaje de WhatsApp:', error);
    return null;
  }
}

// Add this new function to call the agent integration
async function triggerAgentProcessing(conversationId: string, messageId: string): Promise<boolean> {
  try {
    console.log(`🤖 Solicitando procesamiento con agente para mensaje ${messageId} en conversación ${conversationId}`);
    
    // Call our agent processing endpoint
    const agentUrl = new URL('/api/integrations/whatsapp/agent', process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000');
    
    const response = await fetch(agentUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        conversation_id: conversationId,
        message_id: messageId,
      }),
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      console.error(`❌ Error al procesar con agente: ${JSON.stringify(errorData)}`);
      return false;
    }
    
    const data = await response.json();
    console.log(`✅ Mensaje procesado por el agente: ${JSON.stringify(data)}`);
    return true;
  } catch (error) {
    console.error('❌ Error al solicitar procesamiento con agente:', error);
    return false;
  }
}

// Process a WhatsApp message object
async function processWhatsAppMessage(
  message: any,
  phoneNumber: string,
  businessAccountId: string,
  siteId?: string,
  agentId?: string,
  conversationId?: string
): Promise<{
  messageId: string;
  conversationId: string;
  success: boolean;
} | null> {
  try {
    console.log(`📥 Procesando mensaje de WhatsApp de ${phoneNumber.substring(0, 5)}***`);
    
    const messageId = message.id;
    let messageContent: string | null = null;
    
    // Process different message types
    if (message.text) {
      messageContent = message.text.body;
    } else if (message.image) {
      messageContent = await processMediaMessage(message.image, messageId, phoneNumber, businessAccountId);
    } else if (message.audio) {
      messageContent = await processMediaMessage(message.audio, messageId, phoneNumber, businessAccountId);
    } else if (message.video) {
      messageContent = await processMediaMessage(message.video, messageId, phoneNumber, businessAccountId);
    } else if (message.document) {
      messageContent = await processMediaMessage(message.document, messageId, phoneNumber, businessAccountId);
    } else if (message.sticker) {
      messageContent = await processMediaMessage(message.sticker, messageId, phoneNumber, businessAccountId);
    } else if (message.reaction) {
      messageContent = `[reacción: ${message.reaction.emoji}]`;
    } else if (message.location) {
      const { latitude, longitude, name, address } = message.location;
      messageContent = `[ubicación: ${latitude},${longitude}]`;
      if (name) messageContent += ` - ${name}`;
      if (address) messageContent += `, ${address}`;
    } else if (message.contacts) {
      messageContent = `[contactos compartidos: ${message.contacts.length}]`;
    } else {
      messageContent = '[mensaje no soportado]';
    }
    
    if (!messageContent) {
      console.error('❌ No se pudo extraer el contenido del mensaje');
      return null;
    }
    
    // Save the message to our database
    const savedMessage = await saveWhatsAppMessage(
      phoneNumber,
      messageContent,
      businessAccountId,
      messageId,
      conversationId,
      agentId,
      siteId
    );
    
    if (!savedMessage) {
      console.error('❌ Error al guardar el mensaje en la base de datos');
      return null;
    }
    
    console.log(`✅ Mensaje de WhatsApp procesado y guardado con éxito`);
    
    // NEW CODE: If we have an agent ID, trigger agent processing
    if (agentId && isValidUUID(agentId)) {
      console.log(`🤖 Solicitando respuesta del agente ${agentId}`);
      
      // Trigger agent processing asynchronously - don't await to avoid delaying the response
      triggerAgentProcessing(savedMessage.conversationId, savedMessage.messageId)
        .then(success => {
          if (success) {
            console.log(`✅ Procesamiento con agente iniciado correctamente`);
          } else {
            console.error(`❌ Error al iniciar procesamiento con agente`);
          }
        })
        .catch(error => {
          console.error(`❌ Excepción al iniciar procesamiento con agente:`, error);
        });
    } else {
      console.log(`⚠️ No se especificó agentId, no se procesará el mensaje automáticamente`);
    }
    
    return {
      messageId: savedMessage.messageId,
      conversationId: savedMessage.conversationId,
      success: true
    };
  } catch (error) {
    console.error('❌ Error al procesar mensaje de WhatsApp:', error);
    return null;
  }
}

/**
 * Webhook verification for WhatsApp Business API
 * GET endpoint handles the verification challenge from Meta/WhatsApp
 */
export async function GET(request: NextRequest) {
  try {
    // Extract the query parameters required by WhatsApp verification
    const searchParams = request.nextUrl.searchParams;
    const mode = searchParams.get('hub.mode');
    const token = searchParams.get('hub.verify_token');
    const challenge = searchParams.get('hub.challenge');
    
    // Hardcoded verification token
    const verifyToken = 'fg3eU9TPc32AXB5Tf6T6996P2FyXwVr7@Yp9MW2Uh3$b3&*bsq^D959$v7E82cSt';
    
    // Log verification attempt
    console.log(`🔄 Verificación de webhook WhatsApp: mode=${mode}, token=${token ? 'provided' : 'missing'}`);
    
    // Check if this is a valid verification request
    if (mode === 'subscribe' && token === verifyToken && challenge) {
      console.log('✅ Verificación de webhook de WhatsApp exitosa');
      
      // Return the challenge to confirm the webhook
      return new NextResponse(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
    
    // If we reach here, verification failed
    console.warn('❌ Verificación de webhook de WhatsApp fallida: token inválido o faltante');
    return new NextResponse('Verification Failed', { status: 403 });
  } catch (error) {
    console.error('❌ Error durante la verificación del webhook de WhatsApp:', error);
    return new NextResponse('Error', { status: 500 });
  }
}

/**
 * POST handler for receiving webhook events from WhatsApp Business API
 */
export async function POST(request: NextRequest) {
  try {
    // Log the start of webhook processing
    console.log('📩 Webhook de WhatsApp recibido');
    
    // Get the raw request body
    const body = await request.json();
    
    // Debug the webhook body
    console.log(`📄 Contenido del webhook: ${JSON.stringify(body).substring(0, 200)}...`);
    
    // Extract site_id and agent_id from the webhook URL for routing purposes
    const searchParams = request.nextUrl.searchParams;
    const siteId = searchParams.get('site_id');
    const agentId = searchParams.get('agent_id');
    
    if (!siteId || !isValidUUID(siteId)) {
      console.error('❌ site_id inválido o faltante en los parámetros del webhook');
      return NextResponse.json(
        { success: false, error: 'Invalid site_id parameter' },
        { status: 400 }
      );
    }
    
    // Verify that this is a valid WhatsApp webhook request
    if (!body.object || !body.entry || !Array.isArray(body.entry)) {
      console.warn('❌ Formato de webhook de WhatsApp inválido');
      return NextResponse.json(
        { success: false, error: 'Invalid webhook format' },
        { status: 400 }
      );
    }
    
    // Process each entry in the webhook
    for (const entry of body.entry) {
      // Check if this is a WhatsApp Business webhook
      if (!entry.changes || !Array.isArray(entry.changes)) {
        continue;
      }
      
      for (const change of entry.changes) {
        if (change.field !== 'messages') {
          continue;
        }
        
        // Get the WhatsApp Business Account ID
        const businessAccountId = change.value?.metadata?.phone_number_id || 'unknown';
        
        // Process the messages
        if (change.value?.messages && Array.isArray(change.value.messages)) {
          for (const message of change.value.messages) {
            // Only process messages from users, not those sent by the business
            if (message.from && message.type) {
              const phoneNumber = message.from;
              
              // Process the message
              await processWhatsAppMessage(
                message,
                phoneNumber,
                businessAccountId,
                siteId || undefined,
                agentId || undefined
              );
            }
          }
        }
        
        // Process status updates (delivery and read receipts)
        if (change.value?.statuses && Array.isArray(change.value.statuses)) {
          for (const status of change.value.statuses) {
            console.log(`📤 Actualización de estado de mensaje: ${status.status} para mensaje ${status.id}`);
            // Here you could update your database with delivery/read status
          }
        }
      }
    }
    
    // Return success
    return NextResponse.json(
      { success: true },
      { status: 200 }
    );
  } catch (error) {
    console.error('❌ Error al procesar webhook de WhatsApp:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
} 