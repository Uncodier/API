/**
 * Ejemplo de uso del flujo de plantillas de WhatsApp
 * 
 * Demuestra cómo usar las rutas createTemplate y sendTemplate
 * para manejar los escenarios de ventana de respuesta
 */

interface CreateTemplateResponse {
  success: boolean;
  message_id: string;
  template_required: boolean;
  template_id?: string;
  template_status?: string;
  within_window?: boolean;
  window_hours_elapsed?: number;
  error?: string;
}

interface SendTemplateResponse {
  success: boolean;
  message_id?: string;
  twilio_message_id?: string;
  template_id: string;
  status: 'sent' | 'failed' | 'pending';
  error?: string;
}

/**
 * ESCENARIO A: Dentro de ventana de respuesta (< 24 horas)
 * En este caso se puede enviar mensaje directo sin plantillas
 */
async function scenarioA_WithinWindow() {
  console.log('🅰️ ESCENARIO A: Dentro de ventana de respuesta');
  
  const createTemplateRequest = {
    phone_number: '+1234567890',
    message: 'Hola, gracias por tu consulta. Te respondo a continuación...',
    site_id: 'site-uuid-here',
    conversation_id: 'conversation-uuid-here', // Conversación activa reciente
    from: 'Maria from Sales'
  };

  // 1. Llamar a createTemplate para verificar ventana
  const createResponse = await fetch('/api/agents/whatsapp/createTemplate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(createTemplateRequest)
  });

  const createResult: CreateTemplateResponse = await createResponse.json();
  
  console.log('📊 Resultado de createTemplate:', createResult);

  if (createResult.success && !createResult.template_required) {
    console.log('✅ Dentro de ventana - enviar mensaje directo');
    console.log(`⏰ Horas transcurridas: ${createResult.window_hours_elapsed}`);
    
    // En este escenario, usar el servicio normal de WhatsApp
    // (no necesitas las rutas de plantillas)
    return {
      scenario: 'A',
      action: 'send_direct_message',
      message_id: createResult.message_id,
      within_window: true
    };
  }

  console.log('❌ Scenario A failed - should be within window');
  return null;
}

/**
 * ESCENARIO B: Fuera de ventana de respuesta (> 24 horas)
 * En este caso se requiere usar plantillas
 */
async function scenarioB_OutsideWindow() {
  console.log('🅱️ ESCENARIO B: Fuera de ventana de respuesta');
  
  const createTemplateRequest = {
    phone_number: '+1234567890',
    message: 'Hola! Tenemos una promoción especial para ti. Visita nuestro sitio para más detalles.',
    site_id: 'site-uuid-here',
    // Sin conversation_id o conversation_id de hace más de 24h
    from: 'Marketing Team'
  };

  // 1. Llamar a createTemplate para crear/obtener plantilla
  console.log('📝 Paso 1: Crear/verificar plantilla...');
  const createResponse = await fetch('/api/agents/whatsapp/createTemplate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(createTemplateRequest)
  });

  const createResult: CreateTemplateResponse = await createResponse.json();
  
  console.log('📊 Resultado de createTemplate:', createResult);

  if (!createResult.success) {
    console.error('❌ Error creando plantilla:', createResult.error);
    return null;
  }

  if (!createResult.template_required) {
    console.log('⚠️ Expected template to be required but it was not');
    return null;
  }

  console.log('✅ Plantilla requerida y disponible');
  console.log(`📋 Template ID: ${createResult.template_id}`);
  console.log(`📋 Message ID: ${createResult.message_id}`);
  console.log(`⏰ Horas transcurridas: ${createResult.window_hours_elapsed}`);

  // 2. Usar sendTemplate para enviar el mensaje
  console.log('📤 Paso 2: Enviar mensaje con plantilla...');
  
  const sendTemplateRequest = {
    template_id: createResult.template_id!,
    phone_number: createTemplateRequest.phone_number,
    site_id: createTemplateRequest.site_id,
    message_id: createResult.message_id, // Para tracking
    original_message: createTemplateRequest.message
  };

  const sendResponse = await fetch('/api/agents/whatsapp/sendTemplate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sendTemplateRequest)
  });

  const sendResult: SendTemplateResponse = await sendResponse.json();
  
  console.log('📊 Resultado de sendTemplate:', sendResult);

  if (sendResult.success) {
    console.log('✅ Mensaje enviado exitosamente con plantilla');
    console.log(`📧 Twilio Message ID: ${sendResult.twilio_message_id}`);
    
    return {
      scenario: 'B',
      action: 'sent_with_template',
      message_id: createResult.message_id,
      template_id: createResult.template_id,
      twilio_message_id: sendResult.twilio_message_id,
      within_window: false
    };
  } else {
    console.error('❌ Error enviando mensaje:', sendResult.error);
    return null;
  }
}

/**
 * FLUJO INTELIGENTE: Determina automáticamente qué escenario usar
 */
async function smartWhatsAppFlow(
  phoneNumber: string,
  message: string,
  siteId: string,
  conversationId?: string,
  from?: string
) {
  console.log('🧠 FLUJO INTELIGENTE: Determinando escenario...');
  
  // 1. Siempre comenzar con createTemplate para verificar ventana
  const createTemplateRequest = {
    phone_number: phoneNumber,
    message: message,
    site_id: siteId,
    conversation_id: conversationId,
    from: from
  };

  const createResponse = await fetch('/api/agents/whatsapp/createTemplate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(createTemplateRequest)
  });

  const createResult: CreateTemplateResponse = await createResponse.json();
  
  if (!createResult.success) {
    throw new Error(`Error en createTemplate: ${createResult.error}`);
  }

  // 2. Decidir flujo basado en template_required
  if (!createResult.template_required) {
    // ESCENARIO A: Usar API normal de WhatsApp
    console.log('🅰️ Usando flujo directo (dentro de ventana)');
    
    // Aquí llamarías a tu API normal de WhatsApp
    // Por ejemplo: /api/agents/whatsapp/send
    
    return {
      flow: 'direct',
      message_id: createResult.message_id,
      within_window: true,
      window_hours_elapsed: createResult.window_hours_elapsed
    };
    
  } else {
    // ESCENARIO B: Usar plantillas
    console.log('🅱️ Usando flujo de plantillas (fuera de ventana)');
    
    const sendTemplateRequest = {
      template_id: createResult.template_id!,
      phone_number: phoneNumber,
      site_id: siteId,
      message_id: createResult.message_id,
      original_message: message
    };

    const sendResponse = await fetch('/api/agents/whatsapp/sendTemplate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sendTemplateRequest)
    });

    const sendResult: SendTemplateResponse = await sendResponse.json();
    
    if (!sendResult.success) {
      throw new Error(`Error en sendTemplate: ${sendResult.error}`);
    }

    return {
      flow: 'template',
      message_id: createResult.message_id,
      template_id: createResult.template_id,
      twilio_message_id: sendResult.twilio_message_id,
      within_window: false,
      window_hours_elapsed: createResult.window_hours_elapsed
    };
  }
}

/**
 * VERIFICAR ESTADO: Monitorear el progreso de un mensaje
 */
async function trackMessageStatus(messageId: string) {
  console.log(`🔍 Verificando estado del mensaje: ${messageId}`);
  
  // Verificar en createTemplate
  const createTrackResponse = await fetch(`/api/agents/whatsapp/createTemplate?message_id=${messageId}`);
  const createTrackResult = await createTrackResponse.json();
  
  console.log('📋 Estado en createTemplate:', createTrackResult);
  
  // Verificar en sendTemplate
  const sendTrackResponse = await fetch(`/api/agents/whatsapp/sendTemplate?message_id=${messageId}`);
  const sendTrackResult = await sendTrackResponse.json();
  
  console.log('📤 Estado en sendTemplate:', sendTrackResult);
  
  return {
    creation: createTrackResult,
    sending: sendTrackResult
  };
}

// Ejemplos de uso
export {
  scenarioA_WithinWindow,
  scenarioB_OutsideWindow,
  smartWhatsAppFlow,
  trackMessageStatus
};

/**
 * EJEMPLO DE INTEGRACIÓN EN UNA API
 */
/*
// En tu endpoint existente de envío de WhatsApp
app.post('/api/send-whatsapp', async (req, res) => {
  const { phone_number, message, site_id, conversation_id, from } = req.body;
  
  try {
    const result = await smartWhatsAppFlow(
      phone_number,
      message,
      site_id,
      conversation_id,
      from
    );
    
    res.json({
      success: true,
      flow_used: result.flow,
      message_id: result.message_id,
      within_window: result.within_window,
      ...result
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
*/ 