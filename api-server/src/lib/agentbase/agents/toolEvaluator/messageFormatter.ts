/**
 * Message formatting utilities for ToolEvaluator
 */
import { DbCommand } from '../../models/types';
import { TOOL_EVALUATOR_SYSTEM_PROMPT, formatToolEvaluatorPrompt } from '../../prompts/tool-evaluator-prompt';

/**
 * Prepare messages from the command
 */
export function prepareMessagesFromCommand(command: DbCommand, systemPrompt?: string): Array<{
  role: 'system' | 'user' | 'assistant';
  content: string;
}> {
  const messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }> = [];

  // El agent_background es OBLIGATORIO
  if (!command.agent_background) {
    const errorMsg = `[ToolEvaluator] ERROR FATAL: No se encontró agent_background para el comando ${command.id} - Las instrucciones del agente son obligatorias`;
    console.error(errorMsg);
    throw new Error(errorMsg);
  }

  console.log(`[ToolEvaluator] Preparando mensajes para el comando ${command.id}`);
  console.log(`[ToolEvaluator] Agent background: ${command.agent_background.length} caracteres`);
  console.log(`[ToolEvaluator] Primera parte del agent_background: ${command.agent_background.substring(0, 100)}...`);
  
  // Extraer el contexto del usuario (mensaje del usuario)
  const userContext = typeof command.context === 'string'
    ? command.context
    : typeof command.context === 'object' && command.context !== null
      ? JSON.stringify(command.context)
      : '';
  
  console.log(`[ToolEvaluator] Mensaje usuario: ${userContext.length} caracteres`);
  console.log(`[ToolEvaluator] Primera parte del mensaje usuario: ${userContext.substring(0, 100)}...`);
  
  // Extraer el mensaje actual del usuario del contexto
  let currentMessage = '';
  if (typeof userContext === 'string') {
    // Intentar extraer "Current message: [mensaje]" del contexto
    // Usar [\s\S]* en lugar de /s para compatibilidad con versiones anteriores de JavaScript
    const currentMessageMatch = userContext.match(/Current message:\s*([\s\S]*?)(?:\n\s*\n|$)/);
    if (currentMessageMatch && currentMessageMatch[1]) {
      currentMessage = currentMessageMatch[1].trim();
      console.log(`[ToolEvaluator] Mensaje actual extraído: ${currentMessage.length} caracteres`);
      console.log(`[ToolEvaluator] Primera parte del mensaje actual: ${currentMessage.substring(0, 100)}...`);
    } else {
      console.log(`[ToolEvaluator] No se pudo extraer el mensaje actual del usuario del contexto`);
    }
  }
  
  // Procesar las herramientas
  const tools = command.tools || [];
  console.log(`[ToolEvaluator] Procesando ${tools.length} herramientas para evaluación`);
  
  if (tools.length > 0) {
    tools.forEach((tool, index) => {
      console.log(`[ToolEvaluator] Herramienta #${index+1}:`);
      console.log(`  - Nombre: ${tool.name || 'undefined'}`);
      console.log(`  - Descripción: ${tool.description ? tool.description.substring(0, 50) + '...' : 'undefined'}`);
      if (tool.parameters) {
        const requiredParams = tool.parameters.required || [];
        console.log(`  - Parámetros requeridos: ${requiredParams.length > 0 ? requiredParams.join(', ') : 'ninguno'}`);
      }
    });
  }
  
  // Formatear la información de herramientas
  const toolsPrompt = formatToolEvaluatorPrompt(tools);
  console.log(`[ToolEvaluator] Prompt de herramientas: ${toolsPrompt.length} caracteres`);
  console.log(`[ToolEvaluator] Primera parte del prompt de herramientas: ${toolsPrompt.substring(0, 100)}...`);
  
  // El prompt de evaluación de herramientas se AÑADE al agent_background, no lo reemplaza
  // Si se proporciona un systemPrompt personalizado, usarlo en lugar del default
  const toolEvaluatorPrompt = systemPrompt || TOOL_EVALUATOR_SYSTEM_PROMPT;
  console.log(`[ToolEvaluator] Sistema prompt: ${toolEvaluatorPrompt.length} caracteres (${systemPrompt ? 'Personalizado' : 'Default'})`);
  console.log(`[ToolEvaluator] Primera parte del system prompt: ${toolEvaluatorPrompt.substring(0, 100)}...`);
  
  // 1. Combinar agent_background + system prompt + contexto completo + herramientas en el mensaje del sistema
  const systemContent = `${command.agent_background}\n\n${toolEvaluatorPrompt}\n\nCONVERSATION CONTEXT:\n${userContext}\n\n${toolsPrompt}`;
  
  console.log(`[ToolEvaluator] Mensaje sistema combinado: ${systemContent.length} caracteres`);
  messages.push({
    role: 'system',
    content: systemContent
  });
  
  // 2. Añadir el mensaje actual del usuario como único mensaje de usuario
  if (currentMessage) {
    messages.push({
      role: 'user',
      content: currentMessage
    });
  } else {
    // Si no se pudo extraer el mensaje actual, usar el contexto completo como mensaje del usuario
    console.log(`[ToolEvaluator] Usando contexto completo como mensaje del usuario al no poder extraer el mensaje actual`);
    messages.push({
      role: 'user',
      content: userContext
    });
  }

  console.log(`[ToolEvaluator] Total mensajes preparados: ${messages.length} (system[background+prompt+context+tools] + current)`);
  return messages;
}

/**
 * Validate tool structure and normalize format
 */
export function validateAndNormalizeTools(tools: any[]): any[] {
  // Log tool count for debugging
  console.log(`[ToolEvaluator] Validating ${tools.length} tools`);
  
  // Normalize tool format
  const normalizedTools = tools.map((tool, index) => {
    console.log(`[ToolEvaluator] Inspecting tool #${index+1} format:`, 
      JSON.stringify({
        hasType: !!tool.type,
        type: tool.type,
        hasFunction: !!tool.function,
        hasName: !!tool.name,
        hasDescription: !!tool.description
      }));
      
    // Handle nested function format (like OpenAI format)
    if (tool.type === 'function' && tool.function) {
      console.log(`[ToolEvaluator] Converting nested function format for tool #${index+1}`);
      const normalizedTool = {
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters || {},
        type: 'synchronous',
        status: 'not_initialized'
      };
      console.log(`[ToolEvaluator] Normalized tool #${index+1}:`, 
        JSON.stringify({
          name: normalizedTool.name,
          description: normalizedTool.description ? normalizedTool.description.substring(0, 50) + '...' : 'undefined',
          hasParameters: !!normalizedTool.parameters
        }));
      return normalizedTool;
    }
    // Return the tool as is for flat format
    return tool;
  });
  
  // Validate tools structure
  const validatedTools = normalizedTools.map((tool, index) => {
    if (!tool || typeof tool !== 'object') {
      console.error(`[ToolEvaluator] Tool #${index+1} is not a valid object:`, tool);
      return {
        name: `invalid_tool_${index}`,
        description: "Invalid tool object",
        parameters: { type: "object", properties: {} }
      };
    }
    
    if (!tool.name) {
      console.error(`[ToolEvaluator] Tool #${index+1} is missing name:`, tool);
      tool.name = `unnamed_tool_${index}`;
    }
    
    if (!tool.description) {
      console.error(`[ToolEvaluator] Tool #${index+1} '${tool.name}' is missing description`);
      tool.description = "No description provided";
    }
    
    if (!tool.parameters) {
      console.error(`[ToolEvaluator] Tool #${index+1} '${tool.name}' is missing parameters`);
      tool.parameters = { type: "object", properties: {} };
    }
    
    return tool;
  });
  
  return validatedTools;
} 