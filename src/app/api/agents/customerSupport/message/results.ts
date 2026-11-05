import { usableSupportContent } from './response-content';

export function extractSupportResults(executedCommand: any) {
    const rows: any[] = Array.isArray(executedCommand?.results) ? executedCommand.results : [];
    let assistantMessage: string | undefined;
    let conversationTitle: string | undefined;

    for (const row of rows) {
      const title = row?.conversation?.title || row?.content?.conversation?.title
        || (row?.type === 'conversation' ? row?.content?.title : undefined);
      if (typeof title === 'string' && title.trim()) {
        conversationTitle = title;
        break;
      }
    }

    // Preserve message-target priority. Never stringify tool results, metadata,
    // or conversation targets as a substitute for an assistant response.
    const candidates: unknown[] = rows.map(row => row?.message?.content);
    for (const row of rows) {
      if (row?.type === 'message' || row?.type === 'text') {
        candidates.push(row.content, row.content?.message?.content, row.content?.content);
      }
    }
    for (const row of rows) {
      if (typeof row === 'string') candidates.push(row);
      else if (row && !row.type && !row.conversation && !row.tool && !row.tool_call_id) {
        candidates.push(row.content, row.content?.message?.content, row.content?.content, row.text);
      }
    }
    for (const candidate of candidates) {
      assistantMessage = usableSupportContent(candidate);
      if (assistantMessage) break;
    }

    // Extraer flags is_robot, is_transactional_message e is_erratic de los resultados
    let isRobot: boolean | undefined = undefined;
    let isTransactionalMessage: boolean | undefined = undefined;
    let isErratic: boolean | undefined = undefined;

    if (rows.length > 0) {
      // Buscar flags en message target
      const messageResult = rows.find((r: any) =>
        r?.message && typeof r.message === 'object'
      );
      if (messageResult && messageResult.message) {
        if (typeof messageResult.message.is_robot === 'boolean') {
          isRobot = messageResult.message.is_robot;
          console.log(`🤖 Flag is_robot encontrado en message: ${isRobot}`);
        }
        if (typeof messageResult.message.is_transactional_message === 'boolean') {
          isTransactionalMessage = messageResult.message.is_transactional_message;
          console.log(`📧 Flag is_transactional_message encontrado en message: ${isTransactionalMessage}`);
        }
        if (typeof messageResult.message.is_erratic === 'boolean') {
          isErratic = messageResult.message.is_erratic;
          console.log(`⚠️ Flag is_erratic encontrado en message: ${isErratic}`);
        }
      }

      // Buscar flags en conversation target
      const conversationResult = rows.find((r: any) =>
        r?.conversation && typeof r.conversation === 'object'
      );
      if (conversationResult && conversationResult.conversation) {
        if (typeof conversationResult.conversation.is_robot === 'boolean') {
          isRobot = conversationResult.conversation.is_robot;
          console.log(`🤖 Flag is_robot encontrado en conversation: ${isRobot}`);
        }
        if (typeof conversationResult.conversation.is_transactional_message === 'boolean') {
          isTransactionalMessage = conversationResult.conversation.is_transactional_message;
          console.log(`📧 Flag is_transactional_message encontrado en conversation: ${isTransactionalMessage}`);
        }
        if (typeof conversationResult.conversation.is_erratic === 'boolean') {
          isErratic = conversationResult.conversation.is_erratic;
          console.log(`⚠️ Flag is_erratic encontrado en conversation: ${isErratic}`);
        }
      }
    }


return { assistantMessage, conversationTitle, isRobot, isTransactionalMessage, isErratic };
}
