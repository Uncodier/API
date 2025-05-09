/**
 * Ejemplo de integración directa de Composio en ToolEvaluator
 * 
 * Este ejemplo muestra cómo crear un evaluador de herramientas
 * que automáticamente integre herramientas de Composio.
 */
import { ToolEvaluator } from '../agents/ToolEvaluator';
import { PortkeyConnector } from '../services/PortkeyConnector';
import { DbCommand } from '../models/types';
import { configureComposio } from '../utils/composioIntegration';

/**
 * Configuración para integración de Composio
 */
export async function createComposioEnabledEvaluator(
  portkeyConnector: PortkeyConnector,
  options: {
    id?: string;
    name?: string;
    apps?: string[];
    tags?: string[];
    integrationId?: string;
    systemPrompt?: string;
  } = {}
): Promise<ToolEvaluator> {
  // Configurar Composio globalmente para esta sesión
  configureComposio({
    enabled: true,
    apps: options.apps || ['whatsapp', 'gmail', 'calendar'],
    tags: options.tags,
    integrationId: options.integrationId
  });
  
  // Crear un evaluador con Composio ya habilitado globalmente
  const toolEvaluator = new ToolEvaluator(
    options.id || 'composio-tool-evaluator',
    options.name || 'Composio Tool Evaluator',
    portkeyConnector,
    ['tool_evaluation'],
    { // Opciones de modelo
      modelType: 'openai',
      modelId: 'gpt-4o',
      maxTokens: 4000,
      temperature: 0.2
    },
    'Evaluador de herramientas con integración de Composio',
    options.systemPrompt
  );
  
  console.log(`[ComposioIntegration] Evaluador creado con integración de Composio`);
  return toolEvaluator;
}

/**
 * Ejemplo completo: creación del evaluador y procesamiento de un comando
 */
export async function processWithComposioEvaluator(
  command: DbCommand,
  portkeyConnector: PortkeyConnector,
  apps?: string[]
): Promise<DbCommand> {
  try {
    // Crear evaluador con apps específicas
    const evaluator = await createComposioEnabledEvaluator(portkeyConnector, {
      apps: apps || ['whatsapp', 'gmail'] // Especificar qué apps de Composio usar
    });
    
    // Ejecutar la evaluación (ya integra automáticamente las herramientas de Composio)
    const result = await evaluator.executeCommand(command);
    
    if (result.status === 'completed' && result.updatedCommand) {
      console.log(`[ComposioIntegration] Evaluación completada con éxito`);
      return result.updatedCommand;
    } else {
      console.error(`[ComposioIntegration] Error en evaluación: ${result.error || 'desconocido'}`);
      return command;
    }
  } catch (error: any) {
    console.error(`[ComposioIntegration] Error: ${error.message}`);
    return command;
  }
} 