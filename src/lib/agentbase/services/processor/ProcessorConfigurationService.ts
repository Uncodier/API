/**
 * ProcessorConfigurationService - Servicio para configurar los procesadores
 */
import { PortkeyConnector } from '../PortkeyConnector';
import { PortkeyConfig, PortkeyModelOptions } from '../../models/types';
import { ToolEvaluator } from '../../agents/ToolEvaluator';
import { TargetProcessor } from '../../agents/TargetProcessor';
import { Base } from '../../agents/Base';
import { getOpenRouterChatModel } from '@/lib/services/ai/openrouter';

export class ProcessorConfigurationService {
  // Configurar los procesadores para el system
  // EDGE FUNCTIONS: No caching - each request gets fresh configuration
  public configureProcessors(): Record<string, Base> {
    console.log('🚀 [EDGE] Configurando procesadores para Agentbase (fresh config)');
    
    // Crear conector para LLMs con la configuración de Portkey
    const connector = this.createPortkeyConnector();
    
    // Objeto para almacenar los procesadores configurados
    const processors: Record<string, Base> = {};
    
    // 1. Procesador para evaluar herramientas
    processors['tool_evaluator'] = new ToolEvaluator(
      'tool_evaluator',
      'Tool Evaluator',
      connector,
      ['tool_evaluation'],
      {
        modelType: 'openrouter',
        modelId: getOpenRouterChatModel()
        // No temperature - let command or PortkeyConnector defaults handle it
      }
    );
    
    // 2. Procesador para generar respuestas
    processors['target_processor'] = new TargetProcessor(
      'target_processor',
      'Target Processor',
      connector,
      ['target_processing'],
      {
        modelType: 'openrouter',
        modelId: getOpenRouterChatModel(),
        temperature: 0.7,
        stream: false, // Default to non-streaming for stability
        streamOptions: {
          includeUsage: true
        }
      }
    );
    
    // 3. Procesador específico para copywriting
    processors['default_copywriter_agent'] = new TargetProcessor(
      'default_copywriter_agent',
      'Copywriter Agent',
      connector,
      ['copywriting', 'content_creation', 'marketing'],
      {
        modelType: 'openrouter',
        modelId: getOpenRouterChatModel(),
        temperature: 0.7
      }
    );
    
    console.log(`✅ [EDGE] Procesadores configurados: ${Object.keys(processors).join(', ')}`);
    
    return processors;
  }
  
  // Crear y configurar el conector a Portkey
  private createPortkeyConnector(): PortkeyConnector {
    // Configurar las opciones para Portkey
    const portkeyConfig: PortkeyConfig = {
      apiKey: process.env.OPENROUTER_API_KEY,
    };
    
    // Opciones por defecto para el modelo con streaming habilitado
    const defaultModelOptions: PortkeyModelOptions = {
      modelType: 'openrouter',
      modelId: getOpenRouterChatModel(),
      temperature: 0.7,
      stream: false, // Default to non-streaming for stability
      streamOptions: {
        includeUsage: true
      }
    };
    
    // Crear el conector con la configuración
    return new PortkeyConnector(portkeyConfig, defaultModelOptions);
  }
}

// Export the class itself for Edge Functions compatibility
export default ProcessorConfigurationService; 