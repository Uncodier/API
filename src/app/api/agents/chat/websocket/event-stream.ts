import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getConversationMessages } from './conversation-store';

export function createEventStream(
  request: Request, conversationId: string, revalidate: () => Promise<void>,
) {
  let closed = false;
  let channel: ReturnType<typeof supabaseAdmin.channel> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let pending = Promise.resolve();
  const encoder = new TextEncoder();

  const close = () => {
    if (closed) return;
    closed = true; // Invalidate pending async work before any cleanup awaits.
    clearTimeout(timeout);
    clearInterval(heartbeat);
    request.signal.removeEventListener('abort', close);
    if (channel) void Promise.resolve(channel.unsubscribe()).catch(() => {});
    try { controller?.close(); } catch { /* Reader may have cancelled already. */ }
  };
  const authorized = async () => {
    if (closed) return false;
    await revalidate();
    return !closed;
  };
  const send = (data: unknown) => {
    // Serialize checks and sends so failures cannot be overtaken by stale work.
    pending = pending.then(async () => {
      if (await authorized()) controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
    }).catch(close);
    return pending;
  };

  return new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      request.signal.addEventListener('abort', close, { once: true });
      if (request.signal.aborted) { close(); return; }
      timeout = setTimeout(close, 299_000);
      heartbeat = setInterval(() => { void send({ type: 'ping', timestamp: Date.now() }); }, 30_000);
      void (async () => {
        if (!await authorized()) return;
        const messages = await getConversationMessages(conversationId);
        await send({ type: 'message_history', payload: messages });
        if (closed) return;
        channel = supabaseAdmin.channel(`chat:${conversationId}:${crypto.randomUUID()}`);
        channel.on('postgres_changes', {
          event: 'INSERT', schema: 'public', table: 'messages',
          filter: `conversation_id=eq.${conversationId}`,
        }, payload => {
          void send({ type: 'new_message', payload: payload.new });
        }).subscribe(status => {
          if (status === 'SUBSCRIBED') {
            void send({ type: 'connection_established', payload: {
              conversation_id: conversationId, status: 'connected',
            } });
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            close();
          }
        });
      })().catch(close);
    },
    cancel: close,
  });
}