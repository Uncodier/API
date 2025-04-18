/**
 * ProcessorConfigurationService - Servicio para configurar los procesadores
 */
import { PortkeyConnector } from '../PortkeyConnector';
import { PortkeyConfig, PortkeyModelOptions } from '../../models/types';
import { ToolEvaluator } from '../../agents/ToolEvaluator';
import { TargetProcessor } from '../../agents/TargetProcessor';
import { Base } from '../../agents/Base';

export class ProcessorConfigurationService {
  // Configurar los procesadores para el system
  public configureProcessors(): Record<string, Base> {
    console.log('🚀 Configurando procesadores para Agentbase');
    
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
        modelType: 'openai',
        modelId: 'gpt-4o',
        maxTokens: 1000,
        temperature: 0
      }
    );
    
    // 2. Procesador para generar respuestas
    processors['target_processor'] = new TargetProcessor(
      'target_processor',
      'Target Processor',
      connector,
      ['target_processing'],
      {
        modelType: 'openai',
        modelId: 'gpt-4o',
        maxTokens: 2000,
        temperature: 0.2
      }
    );
    
    console.log(`✅ Procesadores configurados: ${Object.keys(processors).join(', ')}`);
    
    return processors;
  }
  
  // Crear y configurar el conector a Portkey
  private createPortkeyConnector(): PortkeyConnector {
    // Configurar las opciones para Portkey
    const portkeyConfig: PortkeyConfig = {
      apiKey: process.env.PORTKEY_API_KEY || '',
      virtualKeys: {
        'anthropic': process.env.ANTHROPIC_API_KEY || '',
        'openai': process.env.AZURE_OPENAI_API_KEY || '',
        'gemini': process.env.GEMINI_API_KEY || ''
      },
      baseURL: 'https://api.portkey.ai/v1'
    };
    
    // Opciones por defecto para el modelo
    const defaultModelOptions: PortkeyModelOptions = {
      modelType: 'openai',
      modelId: 'gpt-4o',
      maxTokens: 4096,
      temperature: 0.7
    };
    
    // Crear el conector con la configuración
    return new PortkeyConnector(portkeyConfig, defaultModelOptions);
  }
}

export default new ProcessorConfigurationService(); 