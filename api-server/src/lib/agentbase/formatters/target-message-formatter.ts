/**
 * Formateador de mensajes para el TargetProcessor
 */
import { DbCommand } from '../models/types';

/**
 * Prepara los mensajes para el target processing
 * 
 * Esta función recibe el comando, el system prompt general y opcionalmente el system prompt del agente.
 * Si command.context ya contiene un prompt formateado (como el resultado de formatTargetProcessorPrompt),
 * lo usará directamente.
 */
export function prepareMessagesForTarget(command: DbCommand, systemPrompt: string, agentSystemPrompt?: string): Array<{
  role: 'system' | 'user' | 'assistant';
  content: string;
}> {
  const messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }> = [];

  // El agent_background es OBLIGATORIO
  if (!command.agent_background) {
    const errorMsg = `[TargetProcessor] ERROR FATAL: No se encontró agent_background para el comando ${command.id} - Las instrucciones del agente son obligatorias`;
    console.error(errorMsg);
    throw new Error(errorMsg);
  }

  console.log(`[TargetProcessor] Usando agent_background del comando (${command.agent_background.length} caracteres)`);
  console.log(`[TargetProcessor] Primera parte del agent_background: ${command.agent_background.substring(0, 100)}...`);
  
  // Combinar agent_background con el system prompt del target
  let systemContent = command.agent_background;

  // Si hay un agentSystemPrompt (instrucciones específicas del agente), agregarlo
  if (agentSystemPrompt && agentSystemPrompt.trim().length > 0) {
    console.log(`[TargetProcessor] Agregando agent system prompt (${agentSystemPrompt.length} caracteres)`);
    systemContent = `${systemContent}\n\n${agentSystemPrompt}`;
  }

  // Agregar el system prompt general si existe
  if (systemPrompt && systemPrompt.trim().length > 0) {
    console.log(`[TargetProcessor] Agregando system prompt general (${systemPrompt.length} caracteres)`);
    systemContent = `${systemContent}\n\n${systemPrompt}`;
  }

  // Añadir el mensaje del sistema combinado
  messages.push({
    role: 'system',
    content: systemContent
  });

  // Preparar el contexto del usuario - podría ser ya el resultado de formatTargetProcessorPrompt
  const userContext = typeof command.context === 'string'
    ? command.context
    : typeof command.context === 'object' && command.context !== null
      ? JSON.stringify(command.context)
      : '';
  
  // Usar el contenido del contexto directamente como mensaje del usuario
  // Si se ha pasado un formattedTargetPrompt como context, se usará sin modificar
  messages.push({
    role: 'user',
    content: userContext
  });

  console.log(`[TargetProcessor] Mensajes preparados: ${messages.length}`);
  return messages;
}