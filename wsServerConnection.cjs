const { authorizeConnection } = require('./wsServerAuthorization.cjs');
const { getConversationMessages, saveMessage, sendAgentResponse } = require('./wsServerMessages.cjs');
const { randomUUID } = require('node:crypto');

async function handleConnection(ws, params, supabase, activeConnections) {
  const { conversation_id, site_id } = params;
  let closed = false;
  let channel;
  let heartbeat;
  let fingerprint;
  let pending = Promise.resolve();
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    activeConnections.delete(ws);
    if (channel) void Promise.resolve(channel.unsubscribe()).catch(() => {});
    if (ws.readyState === ws.OPEN) ws.close(1008, 'Realtime authorization ended');
  };
  // Register cleanup before the first await, including startup authorization.
  ws.on('close', close);
  ws.on('error', close);
  const authorize = async () => {
    if (closed || ws.readyState !== ws.OPEN) { close(); return false; }
    const current = await authorizeConnection(supabase, params);
    if (closed) return false;
    if (!current.ok || (fingerprint && JSON.stringify(current) !== fingerprint)) {
      close(); return false;
    }
    fingerprint = JSON.stringify(current);
    return true;
  };
  const send = data => {
    pending = pending.then(async () => {
      if (await authorize()) ws.send(JSON.stringify(data));
    }).catch(close);
    return pending;
  };
  const history = async (limit = 50, field = 'payload') => {
    if (!await authorize()) return;
    const messages = await getConversationMessages(supabase, conversation_id, limit);
    await send({ type: 'message_history', [field]: messages });
  };
  const error = (code, message) => send({ type: 'error', payload: { code, message } });
  try {
    if (!await authorize()) return;
    const visitor_id = params.claims.visitorId;
    const connection = { socket: ws, conversationId: conversation_id, site_id, lastActivity: Date.now() };
    activeConnections.set(ws, connection);
    heartbeat = setInterval(() => { void send({ type: 'ping', timestamp: Date.now() }); }, 30_000);
    channel = supabase.channel(`chat:${conversation_id}:${randomUUID()}`);
    channel.on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversation_id}`,
    }, payload => { void send({ type: 'new_message', payload: payload.new }); })
      .subscribe(status => {
        if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) close();
      });
    ws.on('message', async raw => {
      try {
        if (!await authorize()) return;
        connection.lastActivity = Date.now();
        const data = JSON.parse(raw.toString());
        switch (data?.type) {
          case 'pong': break;
          case 'get_messages':
            await history(data.limit ?? 50, 'data');
            break;
          case 'subscribe': {
            const subConvId = data.payload?.conversation_id || conversation_id;
            if (subConvId !== conversation_id) {
              await error('CONVERSATION_FORBIDDEN', 'Cannot switch conversations on this connection');
              break;
            }
            await send({ type: 'subscription_ack', payload: {
              conversation_id, status: 'subscribed',
            } });
            break;
          }
          case 'message': {
            const { payload } = data;
            if (!payload || typeof payload.content !== 'string' || !payload.content.trim()
              || payload.content.length > 100_000 || payload.conversation_id !== conversation_id
              || (payload.id != null && typeof payload.id !== 'string')) {
              await error('INVALID_MESSAGE', 'The message fields are invalid');
              break;
            }
            if (!await authorize()) return;
            const saved = await saveMessage(supabase, conversation_id, visitor_id, payload);
            await send({ type: 'message_sent', payload: {
              client_message_id: payload.id, server_message_id: saved.id, timestamp: saved.created_at,
            } });
            if (!closed) void sendAgentResponse(supabase, conversation_id, payload.content, authorize).catch(close);
            break;
          }
          default: await error('UNKNOWN_MESSAGE_TYPE', 'Unknown message type');
        }
      } catch { await error('PROCESSING_ERROR', 'Unable to process message'); }
    });
    await send({ type: 'connection_established', status: 'connected', payload: {
      visitor_id, conversation_id, site_id, timestamp: Date.now(),
    } });
    if (!closed) await history();
  } catch { close(); }
}

module.exports = { handleConnection };