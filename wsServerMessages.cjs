async function getConversationMessages(supabase, conversationId, limit = 50) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid history limit');
  const { data, error } = await supabase.from('messages').select('*')
    .eq('conversation_id', conversationId).order('created_at', { ascending: false }).limit(limit);
  if (error) throw new Error('Unable to load messages');
  return (data || []).reverse();
}

async function saveMessage(supabase, conversationId, visitorId, payload) {
  const { data, error } = await supabase.from('messages').insert([{
    conversation_id: conversationId, content: payload.content, role: 'visitor',
    visitor_id: visitorId, client_message_id: payload.id || null,
  }]).select().single();
  if (error || !data) throw new Error('Unable to save message');
  return data;
}

// Preserve the local development server's automatic acknowledgement behavior.
async function sendAgentResponse(supabase, conversationId, userMessage, authorize) {
  await new Promise(resolve => setTimeout(resolve, 2000));
  if (!await authorize()) return;
  const text = userMessage.toLowerCase();
  let content = 'Thank you for your message. A human agent will assist you soon.';
  if (/hello|hi\b|hola|buenas/.test(text)) content = 'Hello! How can I help you today?';
  else if (/help|problem|ayuda|problema/.test(text)) content = 'I am here to help. Could you share more details?';
  else if (/thanks|gracias/.test(text)) content = 'You are welcome! I am here if you need anything.';
  else if (/configur|agent|agente/.test(text)) content = 'To configure an agent, open Agents in your dashboard and follow the steps.';
  const { error } = await supabase.from('messages').insert([{
    conversation_id: conversationId, content, role: 'assistant', visitor_id: null,
  }]);
  if (error) throw new Error('Unable to save agent response');
}

module.exports = { getConversationMessages, saveMessage, sendAgentResponse };