/**
 * Ejemplo de uso de ComposioTools con ToolEvaluator
 * 
 * Este ejemplo muestra cómo integrar herramientas de Composio
 * dentro del flujo de evaluación de herramientas de Agentbase.
 */

import { ComposioTools } from '../services/composioTools';
import { ToolEvaluator } from '../agents/ToolEvaluator';
import { PortkeyConnector } from '../services/PortkeyConnector';
import { DbCommand } from '../models/types';

/**
 * Función principal para integrar herramientas de Composio
 * con un comando existente antes de procesarlo con ToolEvaluator
 */
export async function enrichCommandWithComposioTools(
  command: DbCommand,
  options: {
    apps?: string[];
    integrationId?: string;
    tags?: string[];
  } = {}
): Promise<DbCommand> {
  try {
    console.log(`[ComposioToolsExample] Enriqueciendo comando ${command.id} con herramientas de Composio`);
    
    // Instanciar el servicio de Composio
    const composioTools = new ComposioTools();
    
    // Obtener herramientas de Composio
    const tools = await composioTools.getTools({
      apps: options.apps,
      integrationId: options.integrationId,
      tags: options.tags
    });
    
    console.log(`[ComposioToolsExample] Obtenidas ${tools.length} herramientas de Composio`);
    
    // Si el comando no tiene tools, inicializar como array vacío
    if (!command.tools) {
      command.tools = [];
    }
    
    // Añadir las herramientas de Composio al comando
    command.tools = [...command.tools, ...tools];
    
    console.log(`[ComposioToolsExample] Comando enriquecido, ahora tiene ${command.tools.length} herramientas`);
    
    return command;
  } catch (error: any) {
    console.error(`[ComposioToolsExample] Error al enriquecer comando: ${error.message}`);
    return command;
  }
}

/**
 * Ejemplo de uso completo
 */
export async function processCommandWithComposioTools(
  command: DbCommand,
  portkeyConnector: PortkeyConnector
): Promise<DbCommand> {
  try {
    // 1. Enriquecer comando con herramientas de Composio
    const enrichedCommand = await enrichCommandWithComposioTools(command, {
      apps: ['whatsapp', 'gmail'] // Ejemplo de apps a integrar
    });
    
    // 2. Crear instancia de ToolEvaluator
    const toolEvaluator = new ToolEvaluator(
      'tool-evaluator-id',
      'Tool Evaluator',
      portkeyConnector
    );
    
    // 3. Ejecutar evaluación de herramientas
    const toolResult = await toolEvaluator.executeCommand(enrichedCommand);
    
    // 4. Verificar resultado y actualizar comando
    if (toolResult.status === 'completed' && toolResult.updatedCommand) {
      console.log(`[ComposioToolsExample] Evaluación completada correctamente`);
      return toolResult.updatedCommand;
    } else {
      console.error(`[ComposioToolsExample] Error en evaluación de herramientas: ${toolResult.error || 'desconocido'}`);
      return enrichedCommand;
    }
  } catch (error: any) {
    console.error(`[ComposioToolsExample] Error en proceso completo: ${error.message}`);
    return command;
  }
} 