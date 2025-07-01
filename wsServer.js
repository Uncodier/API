#!/usr/bin/env node

// Cargar variables de entorno desde .env.local
import { config } from 'dotenv';
config({ path: '.env.local' });

/**
 * WebSocket proxy para desarrollo local.
 * Este servidor se ejecuta junto a Next.js y actúa como un proxy para las conexiones WebSocket.
 */
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { parse } from 'url';
import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';

// Función para validar UUIDs
function isValidUUID(uuid) {
  if (!uuid) return false;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Configuración de Supabase - usar las mismas variables de entorno que usa Next.js
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://wlbrvxjfhzdymbfujcfa.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// Variable para modo offline (sin Supabase)
let OFFLINE_MODE = false;

// Verificar si tenemos las credenciales necesarias
if (!supabaseKey) {
  console.warn('⚠️ Advertencia: No se ha configurado SUPABASE_SERVICE_ROLE_KEY o NEXT_PUBLIC_SUPABASE_ANON_KEY');
  console.warn('📝 El servidor se ejecutará en MODO OFFLINE (sin Supabase)');
  console.warn('ℹ️ Para configurar Supabase:');
  console.warn('1. Crea un archivo .env.local en la raíz del proyecto');
  console.warn('2. Añade las siguientes variables:');
  console.warn('   NEXT_PUBLIC_SUPABASE_URL=https://wlbrvxjfhzdymbfujcfa.supabase.co');
  console.warn('   NEXT_PUBLIC_SUPABASE_ANON_KEY=tu-clave-anon-key');
  console.warn('   SUPABASE_SERVICE_ROLE_KEY=tu-clave-service-role-key (opcional)');
  OFFLINE_MODE = true;
}

// Crear cliente de Supabase o un mock si estamos en modo offline
let supabase;
if (!OFFLINE_MODE) {
  supabase = createClient(supabaseUrl, supabaseKey);
  console.log(`🔌 Conectando a Supabase en: ${supabaseUrl}`);
} else {
  // Mock de Supabase para modo offline
  console.log('🔌 Utilizando mock de Supabase (modo offline)');
  
  // Mock simple para Supabase
  supabase = {
    from: (table) => {
      if (table === 'messages') {
        return {
          select: () => {
            return {
              eq: (field, value) => {
                return {
                  order: (orderField, { ascending }) => {
                    return {
                      limit: (limit) => {
                        const now = new Date().toISOString();
                        console.log(`🔍 [${now}] Mock: Obteniendo mensajes para conversación ${value}`);
                        
                        const messages = inMemoryMessages.get(value) || [];
                        return { 
                          data: ascending ? [...messages] : [...messages].reverse(),
                          error: null
                        };
                      }
                    }
                  }
                }
              }
            }
          },
          insert: (data) => {
            return {
              select: () => {
                return {
                  single: () => {
                    const now = new Date().toISOString();
                    const message = data[0];
                    const conversationId = message.conversation_id;
                    
                    if (!inMemoryMessages.has(conversationId)) {
                      inMemoryMessages.set(conversationId, []);
                    }
                    
                    const id = `mock-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
                    const newMessage = {
                      ...message,
                      id,
                      created_at: now
                    };
                    
                    inMemoryMessages.get(conversationId).push(newMessage);
                    console.log(`✅ [${now}] Mock: Mensaje guardado con ID: ${id}`);
                    
                    // Simular evento para los suscriptores
                    setTimeout(() => {
                      const channelName = `chat:${conversationId}`;
                      if (mockChannels[channelName] && mockChannels[channelName].callbacks) {
                        mockChannels[channelName].callbacks.forEach(callback => {
                          callback({ new: newMessage });
                        });
                      }
                    }, 100);
                    
                    return {
                      data: newMessage,
                      error: null
                    };
                  }
                }
              }
            };
          }
        };
      }
      
      return {
        select: () => ({ data: [], error: null }),
        insert: () => ({ data: null, error: null })
      };
    },
    channel: (channelName) => {
      if (!mockChannels[channelName]) {
        mockChannels[channelName] = {
          callbacks: [],
          status: null,
          statusCallbacks: []
        };
      }
      
      const channelObj = {
        on: (event, config, callback) => {
          mockChannels[channelName].callbacks.push(callback);
          return channelObj;
        },
        subscribe: (statusCallback) => {
          mockChannels[channelName].statusCallbacks.push(statusCallback);
          
          // Simular suscripción exitosa
          setTimeout(() => {
            statusCallback('SUBSCRIBED');
            mockChannels[channelName].status = 'SUBSCRIBED';
          }, 500);
          
          return {
            unsubscribe: () => {
              delete mockChannels[channelName];
              return true;
            }
          };
        }
      };
      
      return channelObj;
    }
  };
}

const PORT = 3002;

// Crear servidor HTTP
const server = createServer();

// Crear WebSocketServer
const wss = new WebSocketServer({ noServer: true });

// Mapa para guardar las conexiones WebSocket activas
const activeConnections = new Map();
// Mapa para guardar las suscripciones a canales de Supabase
const supabaseChannels = new Map();
// Almacenamiento en memoria para mensajes (modo offline)
const inMemoryMessages = new Map();
// Almacenamiento para canales mock (modo offline)
const mockChannels = {};

// Función para registrar el estado del servidor periódicamente
function setupServerStatusLogger() {
  console.log('⏱️ Configurando registro periódico del estado del servidor');
  
  // Registrar estado cada minuto
  setInterval(() => {
    const now = new Date().toISOString();
    const memoryUsage = Math.round(process.memoryUsage().heapUsed / 1024 / 1024 * 100) / 100;
    
    console.log(`📊 [${now}] ESTADO DEL SERVIDOR:`);
    console.log(`👥 [${now}] Conexiones activas: ${activeConnections.size}`);
    console.log(`🔗 [${now}] Canales de Supabase activos: ${supabaseChannels.size}`);
    console.log(`💾 [${now}] Uso de memoria: ${memoryUsage} MB`);
    
    // Listar todas las conexiones activas
    if (activeConnections.size > 0) {
      console.log(`📋 [${now}] Detalle de conexiones activas:`);
      let index = 1;
      for (const [visitorId, connection] of activeConnections.entries()) {
        const lastActivityTime = new Date(connection.lastActivity).toISOString();
        const inactiveTime = Math.round((Date.now() - connection.lastActivity) / 1000);
        console.log(`   ${index}. visitor=${visitorId}, conversation=${connection.conversationId}, última actividad: ${lastActivityTime} (hace ${inactiveTime}s)`);
        index++;
      }
    }
  }, 60000); // Cada minuto
}

// Función para obtener mensajes históricos de una conversación
async function getConversationMessages(conversationId, limit = 50) {
  const now = new Date().toISOString();
  try {
    console.log(`🔍 [${now}] Obteniendo mensajes para la conversación ${conversationId}, límite: ${limit}`);
    
    // Verificar si el conversationId tiene formato de UUID válido
    if (!isValidUUID(conversationId)) {
      console.warn(`⚠️ [${now}] ID de conversación no es un UUID válido: ${conversationId}, usando modo offline para este ID`);
      
      // Usar almacenamiento en memoria para IDs no válidos
      const messages = inMemoryMessages.get(conversationId) || [];
      if (messages.length === 0) {
        console.log(`⚠️ [${now}] No se encontraron mensajes para la conversación ${conversationId} (modo mixto)`);
      } else {
        console.log(`✅ [${now}] Se encontraron ${messages.length} mensajes para la conversación ${conversationId} (modo mixto)`);
      }
      return messages.slice(-limit); // Devolver los últimos 'limit' mensajes
    }
    
    // Si estamos en modo offline, usamos el mock
    if (OFFLINE_MODE) {
      console.log(`🔍 [${now}] Usando almacenamiento en memoria (modo offline)`);
      const messages = inMemoryMessages.get(conversationId) || [];
      if (messages.length === 0) {
        console.log(`⚠️ [${now}] No se encontraron mensajes para la conversación ${conversationId} (modo offline)`);
      } else {
        console.log(`✅ [${now}] Se encontraron ${messages.length} mensajes para la conversación ${conversationId} (modo offline)`);
      }
      return messages.slice(-limit); // Devolver los últimos 'limit' mensajes
    }
    
    // Si no estamos en modo offline y el ID es válido, usamos Supabase
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(limit);
    
    if (error) {
      console.error(`❌ [${now}] Error al obtener mensajes:`, error);
      return [];
    }
    
    if (!data || data.length === 0) {
      console.log(`⚠️ [${now}] No se encontraron mensajes para la conversación ${conversationId}`);
      return [];
    }
    
    console.log(`✅ [${now}] Se encontraron ${data.length} mensajes para la conversación ${conversationId}`);
    return data.reverse(); // Revertir para orden cronológico
  } catch (error) {
    console.error(`❌ [${now}] Error al obtener mensajes de la conversación:`, error);
    return [];
  }
}

// Función para enviar una respuesta automática del agente
async function sendAgentResponse(conversationId, visitor_id, userMessage) {
  const now = new Date().toISOString();
  try {
    // Esperar un poco para simular el procesamiento del agente
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    console.log(`🤖 [${now}] Preparando respuesta del agente para la conversación ${conversationId}`);
    
    // Aquí se podría integrar con un servicio de IA para generar respuestas
    // Por ahora, generamos una respuesta simple basada en el mensaje del usuario
    let responseContent = "Gracias por tu mensaje. Un agente humano te atenderá pronto.";
    
    // Simular algunas respuestas básicas para pruebas
    if (userMessage.toLowerCase().includes("hola") || userMessage.toLowerCase().includes("buenas")) {
      responseContent = "¡Hola! ¿En qué puedo ayudarte hoy?";
    } else if (userMessage.toLowerCase().includes("ayuda") || userMessage.toLowerCase().includes("problema")) {
      responseContent = "Estoy aquí para ayudarte. ¿Podrías darme más detalles sobre tu problema?";
    } else if (userMessage.toLowerCase().includes("gracias")) {
      responseContent = "¡De nada! Estoy aquí para lo que necesites.";
    } else if (userMessage.toLowerCase().includes("configurar") || userMessage.toLowerCase().includes("agente")) {
      responseContent = "Para configurar un nuevo agente, ve a la sección de 'Agentes' en tu panel de control y sigue los pasos indicados.";
    }
    
    console.log(`📝 [${now}] Contenido de respuesta generada: "${responseContent}"`);
    
    // Mensaje que vamos a insertar
    const agentMessageData = {
      conversation_id: conversationId,
      content: responseContent,
      role: 'assistant',
      visitor_id: null // El mensaje es del agente, no del visitante
    };
    
    let agentMessage;
    
    // Guardar la respuesta del agente en la base de datos o en memoria
    if (OFFLINE_MODE) {
      // En modo offline, usar el almacenamiento en memoria
      if (!inMemoryMessages.has(conversationId)) {
        inMemoryMessages.set(conversationId, []);
      }
      
      const id = `mock-agent-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      agentMessage = {
        ...agentMessageData,
        id,
        created_at: now
      };
      
      inMemoryMessages.get(conversationId).push(agentMessage);
      console.log(`✅ [${now}] Respuesta del agente guardada con ID: ${id} (modo offline)`);
      
      // Simular evento para los suscriptores en modo offline
      setTimeout(() => {
        const channelName = `chat:${conversationId}`;
        if (mockChannels[channelName]) {
          mockChannels[channelName].callbacks.forEach(callback => {
            callback({ new: agentMessage });
          });
        }
      }, 500);
    } else {
      // En modo normal, usar Supabase
      const { data, error } = await supabase
        .from('messages')
        .insert([agentMessageData])
        .select()
        .single();
        
      if (error) {
        console.error(`❌ [${now}] Error al guardar respuesta del agente en la base de datos:`, error);
        return false;
      }
      
      agentMessage = data;
      console.log(`✅ [${now}] Respuesta del agente guardada con ID: ${agentMessage.id}`);
    }
    
    return true;
  } catch (error) {
    console.error(`❌ [${now}] Error al enviar respuesta del agente:`, error);
    return false;
  }
}

// Función para suscribirse a los cambios de Supabase para una conversación
function subscribeToConversation(conversationId, ws, visitor_id) {
  const now = new Date().toISOString();
  if (!conversationId) {
    console.error(`❌ [${now}] No se puede suscribir: ID de conversación no válido`);
    return null;
  }
  
  try {
    console.log(`📢 [${now}] Suscribiendo a conversación: ${conversationId}`);
    
    // Verificar si el conversationId tiene formato de UUID válido
    if (!isValidUUID(conversationId)) {
      console.warn(`⚠️ [${now}] ID de conversación no es un UUID válido: ${conversationId}, usando modo offline para este ID`);
      
      // Usar el modo offline para IDs no válidos
      console.log(`📢 [${now}] Usando mock de canal para conversación: ${conversationId} (modo mixto)`);
      
      // Crear o usar canal existente
      const channelName = `chat:${conversationId}`;
      if (!mockChannels[channelName]) {
        mockChannels[channelName] = {
          callbacks: [],
          status: null,
          statusCallbacks: []
        };
      }
      
      // Registrar un callback para nuevos mensajes
      const callback = (payload) => {
        try {
          const eventNow = new Date().toISOString();
          console.log(`📨 [${eventNow}] Nuevo mensaje recibido para conversación ${conversationId}, message_id=${payload.new.id} (modo mixto)`);
          ws.send(JSON.stringify({ 
            type: 'new_message', 
            payload: payload.new
          }));
          console.log(`📤 [${eventNow}] Mensaje enviado al cliente: visitor=${visitor_id}, message_id=${payload.new.id} (modo mixto)`);
        } catch (error) {
          const errorNow = new Date().toISOString();
          console.error(`❌ [${errorNow}] Error al enviar mensaje nuevo a través de WebSocket (modo mixto):`, error);
        }
      };
      
      // Añadir callback a la lista
      mockChannels[channelName].callbacks.push(callback);
      
      // Crear un objeto que represente la suscripción
      const mockSubscription = {
        unsubscribe: () => {
          const index = mockChannels[channelName].callbacks.indexOf(callback);
          if (index !== -1) {
            mockChannels[channelName].callbacks.splice(index, 1);
          }
          console.log(`📢 [${new Date().toISOString()}] Callback eliminado para conversación: ${conversationId} (modo mixto)`);
          return true;
        }
      };
      
      // Enviar notificación de suscripción exitosa
      setTimeout(() => {
        const statusNow = new Date().toISOString();
        console.log(`📡 [${statusNow}] Suscripción a mensajes para conversación ${conversationId}: SUBSCRIBED (modo mixto)`);
        console.log(`✅ [${statusNow}] Canal mock guardado para conversación ${conversationId} (modo mixto)`);
      }, 500);
      
      return mockSubscription;
    }
    
    // Si estamos en modo offline, usar el mock de canales
    if (OFFLINE_MODE) {
      console.log(`📢 [${now}] Usando mock de canal para conversación: ${conversationId} (modo offline)`);
      
      // Crear o usar canal existente
      const channelName = `chat:${conversationId}`;
      if (!mockChannels[channelName]) {
        mockChannels[channelName] = {
          callbacks: [],
          status: null,
          statusCallbacks: []
        };
      }
      
      // Registrar un callback para nuevos mensajes
      const callback = (payload) => {
        try {
          const eventNow = new Date().toISOString();
          console.log(`📨 [${eventNow}] Nuevo mensaje recibido para conversación ${conversationId}, message_id=${payload.new.id} (modo offline)`);
          ws.send(JSON.stringify({ 
            type: 'new_message', 
            payload: payload.new
          }));
          console.log(`📤 [${eventNow}] Mensaje enviado al cliente: visitor=${visitor_id}, message_id=${payload.new.id} (modo offline)`);
        } catch (error) {
          const errorNow = new Date().toISOString();
          console.error(`❌ [${errorNow}] Error al enviar mensaje nuevo a través de WebSocket (modo offline):`, error);
        }
      };
      
      // Añadir callback a la lista
      mockChannels[channelName].callbacks.push(callback);
      
      // Crear un objeto que represente la suscripción
      const mockSubscription = {
        unsubscribe: () => {
          const index = mockChannels[channelName].callbacks.indexOf(callback);
          if (index !== -1) {
            mockChannels[channelName].callbacks.splice(index, 1);
          }
          console.log(`📢 [${new Date().toISOString()}] Callback eliminado para conversación: ${conversationId} (modo offline)`);
          return true;
        }
      };
      
      // Enviar notificación de suscripción exitosa
      setTimeout(() => {
        const statusNow = new Date().toISOString();
        console.log(`📡 [${statusNow}] Suscripción a mensajes para conversación ${conversationId}: SUBSCRIBED (modo offline)`);
        console.log(`✅ [${statusNow}] Canal mock guardado para conversación ${conversationId} (modo offline)`);
      }, 500);
      
      return mockSubscription;
    }
    
    // Si no estamos en modo offline y el ID es válido, usar Supabase
    const channel = supabase
      .channel(`chat:${conversationId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `conversation_id=eq.${conversationId}`
      }, (payload) => {
        try {
          const eventNow = new Date().toISOString();
          console.log(`📨 [${eventNow}] Nuevo mensaje recibido para conversación ${conversationId}, message_id=${payload.new.id}`);
          ws.send(JSON.stringify({ 
            type: 'new_message', 
            payload: payload.new
          }));
          console.log(`📤 [${eventNow}] Mensaje enviado al cliente: visitor=${visitor_id}, message_id=${payload.new.id}`);
        } catch (error) {
          const errorNow = new Date().toISOString();
          console.error(`❌ [${errorNow}] Error al enviar mensaje nuevo a través de WebSocket:`, error);
        }
      })
      .subscribe((status) => {
        const statusNow = new Date().toISOString();
        console.log(`📡 [${statusNow}] Suscripción a mensajes para conversación ${conversationId}: ${status}`);
        
        // Si la suscripción fue exitosa, guardarla en el mapa
        if (status === 'SUBSCRIBED') {
          supabaseChannels.set(conversationId, channel);
          console.log(`✅ [${statusNow}] Canal de Supabase guardado para conversación ${conversationId}`);
        }
      });
    
    return channel;
  } catch (error) {
    console.error(`❌ [${now}] Error al suscribirse a la conversación ${conversationId}:`, error);
    return null;
  }
}

// Configurar evento de conexión
wss.on('connection', async (ws, req, params) => {
  const now = new Date().toISOString();
  console.log(`🟢 [${now}] Nueva conexión WebSocket establecida`);

  const { visitor_id, site_id, conversation_id } = params;
  console.log(`📊 [${now}] Datos de conexión: visitor=${visitor_id}, conversation=${conversation_id}, site=${site_id}`);

  // Validar los parámetros requeridos
  if (!visitor_id || !conversation_id) {
    console.error(`❌ [${now}] Faltan parámetros requeridos: visitor_id o conversation_id`);
    ws.send(JSON.stringify({
      type: 'error',
      payload: {
        code: 'MISSING_PARAMETERS',
        message: 'Faltan parámetros requeridos'
      }
    }));
    return;
  }

  // Guardar la conexión en el mapa
  activeConnections.set(visitor_id, {
    socket: ws,
    lastActivity: Date.now(),
    conversationId: conversation_id,
    site_id
  });
  console.log(`🗃️ [${now}] Conexión registrada para visitor=${visitor_id}. Total de conexiones activas: ${activeConnections.size}`);

  // Suscribirse a los cambios de la conversación en Supabase
  const channel = subscribeToConversation(conversation_id, ws, visitor_id);
  if (channel) {
    console.log(`✅ [${now}] Suscripción a Supabase creada para conversación ${conversation_id}`);
  } else {
    console.warn(`⚠️ [${now}] No se pudo establecer suscripción a Supabase para conversación ${conversation_id}`);
  }

  // Evento de recepción de mensajes
  ws.on('message', async (message) => {
    try {
      const messageStr = message.toString();
      const now = new Date().toISOString();
      console.log(`📩 [${now}] Mensaje recibido de visitor=${visitor_id}, conversation=${conversation_id}:`, messageStr);
      
      // Actualizar timestamp de la última actividad
      if (visitor_id && activeConnections.has(visitor_id)) {
        const connection = activeConnections.get(visitor_id);
        connection.lastActivity = Date.now();
        activeConnections.set(visitor_id, connection);
      }
      
      // Analizar el mensaje
      const data = JSON.parse(messageStr);
      
      // Procesar el mensaje según su tipo
      switch (data.type) {
        case 'pong':
          // Respuesta a nuestro ping, actualizar actividad
          console.log(`📡 [${now}] Pong recibido de ${visitor_id}, timestamp: ${data.timestamp}`);
          break;
          
        case 'get_messages':
          // Solicitud para obtener mensajes históricos
          console.log(`🔍 [${now}] Solicitud de historial de mensajes para conversación ${conversation_id}, límite: ${data.limit || 50}`);
          const messages = await getConversationMessages(conversation_id, data.limit || 50);
          console.log(`📤 [${now}] Enviando ${messages.length} mensajes históricos a visitor=${visitor_id}`);
          ws.send(JSON.stringify({
            type: 'message_history',
            data: messages
          }));
          break;
          
        case 'subscribe':
          // Cliente solicitando suscripción a conversación
          const subConvId = data.payload?.conversation_id || conversation_id;
          console.log(`📥 [${now}] Suscripción a conversación ${subConvId} recibida de ${visitor_id}`);
          // Enviar ACK de la suscripción (usando el formato original que espera el cliente)
          ws.send(JSON.stringify({
            type: 'subscription_ack',
            payload: {
              conversation_id: subConvId,
              status: 'subscribed'
            }
          }));
          console.log(`📤 [${now}] Enviada confirmación de suscripción para conversación ${subConvId} a visitor=${visitor_id}`);
          break;
          
        case 'message':
          // Cliente enviando un nuevo mensaje para guardar en la base de datos
          console.log(`💬 [${now}] Nuevo mensaje para conversación ${conversation_id} recibido de ${visitor_id}`);
          console.log(`📝 [${now}] Contenido del mensaje: "${data.payload?.content}"`);
          try {
            const { payload } = data;
            
            if (!payload || !payload.content || !payload.conversation_id) {
              console.error(`❌ [${now}] Mensaje inválido: falta contenido o ID de conversación`);
              ws.send(JSON.stringify({
                type: 'error',
                payload: {
                  code: 'INVALID_MESSAGE',
                  message: 'El mensaje no contiene los campos requeridos'
                }
              }));
              break;
            }
            
            // Crear el mensaje en la base de datos
            const { data: newMessage, error } = await supabase
              .from('messages')
              .insert([{
                conversation_id: payload.conversation_id,
                content: payload.content,
                role: 'visitor',
                visitor_id: visitor_id,
                client_message_id: payload.id || null // Guardar el ID del cliente si está disponible
              }])
              .select()
              .single();
              
            if (error) {
              console.error('❌ Error al guardar mensaje en la base de datos:', error);
              ws.send(JSON.stringify({
                type: 'error',
                payload: {
                  code: 'DATABASE_ERROR',
                  message: 'Error al guardar el mensaje'
                }
              }));
              break;
            }
            
            console.log(`✅ Mensaje guardado en la base de datos con ID: ${newMessage.id}`);
            
            // Enviar confirmación al cliente
            ws.send(JSON.stringify({
              type: 'message_sent',
              payload: {
                client_message_id: payload.id,
                server_message_id: newMessage.id,
                timestamp: newMessage.created_at
              }
            }));
            
            console.log(`📤 [${now}] Confirmación de mensaje enviada a visitor=${visitor_id}, message_id=${newMessage.id}`);
            
            // Enviar respuesta automática del agente (para desarrollo)
            console.log(`🤖 [${now}] Generando respuesta automática para conversación ${payload.conversation_id}`);
            await sendAgentResponse(payload.conversation_id, visitor_id, payload.content);
            
            // Nota: No es necesario emitir el mensaje de vuelta al cliente
            // ya que Supabase se encargará de enviar el mensaje a través del canal suscrito
          } catch (msgError) {
            console.error(`❌ [${now}] Error al procesar el mensaje:`, msgError);
            ws.send(JSON.stringify({
              type: 'error',
              payload: {
                code: 'PROCESSING_ERROR',
                message: 'Error al procesar el mensaje'
              }
            }));
          }
          break;
          
        default:
          console.log(`❓ [${now}] Mensaje no reconocido de ${visitor_id}:`, data);
          // Enviar respuesta de error en formato válido
          ws.send(JSON.stringify({
            type: 'error',
            payload: {
              code: 'UNKNOWN_MESSAGE_TYPE',
              message: `Tipo de mensaje no reconocido: ${data.type}`
            }
          }));
          console.log(`📤 [${now}] Error enviado a visitor=${visitor_id}: tipo de mensaje no reconocido "${data.type}"`);
      }
    } catch (error) {
      console.error(`❌ [${now}] Error al procesar mensaje:`, error);
      ws.send(JSON.stringify({
        type: 'error',
        payload: {
          code: 'PARSE_ERROR',
          message: 'Error al procesar el mensaje'
        }
      }));
    }
  });

  // Evento de cierre de conexión
  ws.on('close', () => {
    const closeNow = new Date().toISOString();
    console.log(`🔌 [${closeNow}] Conexión WebSocket cerrada para ${visitor_id}`);
    
    // Cancelar la suscripción a Supabase
    if (conversation_id && supabaseChannels.has(conversation_id)) {
      console.log(`📢 [${closeNow}] Cancelando suscripción a conversación: ${conversation_id}`);
      const channel = supabaseChannels.get(conversation_id);
      channel.unsubscribe();
      supabaseChannels.delete(conversation_id);
    }
    
    // Eliminar la conexión del mapa
    if (visitor_id) {
      activeConnections.delete(visitor_id);
      console.log(`🗑️ [${closeNow}] Conexión eliminada para visitor=${visitor_id}. Conexiones activas restantes: ${activeConnections.size}`);
    }
  });

  // Enviar mensaje inicial con datos de la conexión
  ws.send(JSON.stringify({
    type: 'connection_established',
    status: 'connected',
    payload: {
      visitor_id,
      conversation_id,
      site_id,
      timestamp: Date.now()
    }
  }));
  console.log(`📤 [${now}] Mensaje de conexión establecida enviado a visitor=${visitor_id}`);

  // Obtener y enviar historial de mensajes inicial
  console.log(`🔍 [${now}] Obteniendo historial inicial para conversación ${conversation_id}`);
  const initialMessages = await getConversationMessages(conversation_id);
  ws.send(JSON.stringify({
    type: 'message_history',
    payload: initialMessages
  }));

  // Configurar heartbeat
  const pingInterval = setInterval(() => {
    try {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
      } else {
        clearInterval(pingInterval);
      }
    } catch (error) {
      console.error('❌ Error al enviar ping:', error);
      clearInterval(pingInterval);
    }
  }, 30000);

  // Configurar envío de mensajes de prueba para conversaciones con ID no válido
  let testMessageInterval;
  if (!isValidUUID(conversation_id)) {
    console.log(`🧪 [${now}] Configurando envío de mensajes de prueba para conversation=${conversation_id} (ID no válido)`);
    testMessageInterval = setInterval(() => {
      try {
        if (ws.readyState === ws.OPEN) {
          const mockMessageId = `test-${Date.now()}`;
          const mockMessage = {
            id: mockMessageId,
            conversation_id: conversation_id,
            content: `Este es un mensaje de prueba automático (${new Date().toLocaleTimeString()})`,
            role: 'assistant',
            created_at: new Date().toISOString()
          };
          
          console.log(`🧪 [${new Date().toISOString()}] Enviando mensaje de prueba id=${mockMessageId} a visitor=${visitor_id}`);
          
          // Enviar mensaje de prueba como new_message
          ws.send(JSON.stringify({ 
            type: 'new_message', 
            payload: mockMessage
          }));
          
          // También almacenar el mensaje en la memoria para simular una base de datos
          if (!inMemoryMessages.has(conversation_id)) {
            inMemoryMessages.set(conversation_id, []);
          }
          inMemoryMessages.get(conversation_id).push(mockMessage);
        } else {
          clearInterval(testMessageInterval);
        }
      } catch (error) {
        console.error('❌ Error al enviar mensaje de prueba:', error);
        clearInterval(testMessageInterval);
      }
    }, 15000); // Enviar mensaje de prueba cada 15 segundos
  }

  // Limpiar los intervalos cuando se cierre la conexión
  ws.on('close', () => {
    clearInterval(pingInterval);
    if (testMessageInterval) {
      clearInterval(testMessageInterval);
    }
  });
});

// Manejar actualizaciones de conexión
server.on('upgrade', (request, socket, head) => {
  const { pathname, query } = parse(request.url, true);
  const upgradeNow = new Date().toISOString();

  // Solo manejar conexiones a nuestra ruta WebSocket
  // Aceptar tanto /ws como la ruta completa /api/agents/chat/websocket
  if (pathname === '/ws' || pathname === '/api/agents/chat/websocket') {
    console.log(`🔌 [${upgradeNow}] Conexión WebSocket entrante en ruta: ${pathname}`);
    wss.handleUpgrade(request, socket, head, (ws) => {
      const params = {
        visitor_id: query.visitor_id,
        site_id: query.site_id,
        conversation_id: query.conversation_id
      };
      
      // Verificar si el conversation_id tiene formato de UUID válido, si no, convertirlo
      if (params.conversation_id && !isValidUUID(params.conversation_id)) {
        console.log(`⚠️ [${upgradeNow}] Formato de conversation_id no válido: ${params.conversation_id}`);
        
        // Extraer números del ID si existe o generar uno nuevo
        const numericPart = params.conversation_id.replace(/\D/g, '');
        const timestamp = numericPart || Date.now().toString();
        
        // Generar un UUID v4 utilizando uuidv4() o construir uno basado en el timestamp
        const uuid = uuidv4();
        console.log(`🔄 [${upgradeNow}] Convirtiendo conversation_id a UUID: ${uuid}`);
        params.conversation_id = uuid;
      }
      
      console.log(`📊 [${upgradeNow}] Parámetros de conexión: `, params);
      wss.emit('connection', ws, request, params);
    });
  } else {
    console.log(`❌ [${upgradeNow}] Ruta WebSocket no válida: ${pathname}`);
    socket.destroy();
  }
});

// Iniciar servidor
server.listen(PORT, () => {
  const startNow = new Date().toISOString();
  console.log(`🚀 [${startNow}] Servidor WebSocket ejecutándose en http://localhost:${PORT}/ws`);
  console.log(`💡 [${startNow}] WebSocket también disponible en: ws://localhost:${PORT}/api/agents/chat/websocket`);
  console.log(`📡 [${startNow}] Conecta desde el cliente a ws://localhost:${PORT}/api/agents/chat/websocket?visitor_id=XXX&site_id=YYY&conversation_id=ZZZ`);
  console.log(`📊 [${startNow}] Memoria utilizada: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024 * 100) / 100} MB`);
  console.log(`🔄 [${startNow}] Entorno: ${process.env.NODE_ENV || 'development'}`);
  
  // Iniciar el logger de estado
  setupServerStatusLogger();
});