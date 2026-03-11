/**
 * Utilidad para construir y gestionar opciones de configuración de modelos
 */
import { PortkeyModelOptions } from '../models/types';

export class ModelOptionsBuilder {
  /**
   * Combina las opciones del comando con las opciones por defecto para crear la configuración final
   */
  static buildModelOptions(
    commandModelType?: string, 
    commandModelId?: string, 
    commandMaxTokens?: number, 
    commandTemperature?: number, 
    commandResponseFormat?: 'json' | 'text',
    defaultOptions?: Partial<PortkeyModelOptions>,
    siteId?: string
  ): PortkeyModelOptions {
    // Configurar opciones del modelo
    const modelOptions: PortkeyModelOptions = {
      modelType: this.getValidModelType(commandModelType, defaultOptions?.modelType),
      modelId: commandModelId || defaultOptions?.modelId || 'gpt-4o',
      temperature: commandTemperature || defaultOptions?.temperature || 0.2,
      responseFormat: commandResponseFormat || defaultOptions?.responseFormat || 'json',
      siteId: siteId || defaultOptions?.siteId
    };
    
    return modelOptions;
  }
  
  /**
   * Asegura que el tipo de modelo sea válido
   */
  private static getValidModelType(
    modelType?: string, 
    defaultModelType?: string
  ): 'anthropic' | 'openai' | 'gemini' {
    // Validar tipo de modelo
    if (modelType === 'anthropic' || modelType === 'openai' || modelType === 'gemini') {
      return modelType;
    }
    
    if (defaultModelType === 'anthropic' || defaultModelType === 'openai' || defaultModelType === 'gemini') {
      return defaultModelType;
    }
    
    // Valor por defecto si no hay un valor válido
    return 'openai';
  }
} 