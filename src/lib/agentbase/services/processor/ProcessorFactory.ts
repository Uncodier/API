/**
 * ProcessorFactory - Fábrica para crear procesadores
 */
import { PortkeyConnector } from '../PortkeyConnector';
import { AgentConnector } from '../../agents/AgentConnector';
import { ToolEvaluator } from '../../agents/ToolEvaluator';
import { TargetProcessor } from '../../agents/TargetProcessor';
import { PortkeyConfig } from '../../models/types';
import { Base } from '../../agents/Base';

export class ProcessorFactory {
  /**
   * Crea y configura todos los procesadores necesarios
   */
  public createProcessors(): Record<string, Base> {
    const processors: Record<string, Base> = {};
    
    // Crear conector para LLMs
    const connector = this.createPortkeyConnector();
    
    // 1. Agente principal para soporte al cliente
    processors['default_customer_support_agent'] = this.createCustomerSupportAgent(connector);
    
    // 2. Procesador para evaluar herramientas
    processors['tool_evaluator'] = this.createToolEvaluator(connector);
    
    // 3. Procesador para generar respuestas
    processors['target_processor'] = this.createTargetProcessor(connector);
    
    return processors;
  }

  /**
   * Crea conector para LLMs
   */
  private createPortkeyConnector(): PortkeyConnector {
    const portkeyConfig: PortkeyConfig = {
      apiKey: process.env.PORTKEY_API_KEY || '',
      virtualKeys: {
        'anthropic': process.env.ANTHROPIC_API_KEY || '',
        'openai': process.env.AZURE_OPENAI_API_KEY || '',
        'gemini': process.env.GEMINI_API_KEY || ''
      },
      baseURL: 'https://api.portkey.ai/v1'
    };
    
    return new PortkeyConnector(portkeyConfig, {
      modelType: 'openai',
      modelId: 'gpt-4o',
      maxTokens: 4096,
      temperature: 0.7
    });
  }

  /**
   * Crea el agente de soporte al cliente
   */
  private createCustomerSupportAgent(connector: PortkeyConnector): AgentConnector {
    return new AgentConnector(
      'default_customer_support_agent',
      'Customer Support Agent',
      connector,
      ['customer_support', 'order_tracking', 'issue_resolution'],
      {
        defaultOptions: {
          modelType: 'openai',
          modelId: 'gpt-4o',
          maxTokens: 4000,
          temperature: 0.7
        },
        description: "Agente de soporte al cliente especializado en resolver problemas relacionados con pedidos, productos y servicios.",
        systemPrompt: `You are a customer support agent. Your role is to help customers with their inquiries, solve problems, and provide excellent service.

Instructions:
1. Be friendly and professional at all times.
2. Address the customer's questions directly.
3. If you don't know an answer, be honest about it.
4. Prioritize customer satisfaction above all else.
5. Be empathetic to customer concerns.
6. Your name is "Customer Support Agent" - whenever asked about your name, identity or what you are, respond with this name.

Remember that you represent the company and should maintain a helpful, positive attitude.`
      }
    );
  }

  /**
   * Crea el evaluador de herramientas
   */
  public createToolEvaluator(connector?: PortkeyConnector): ToolEvaluator {
    // Si no se proporciona un conector, crear uno nuevo
    const actualConnector = connector || this.createPortkeyConnector();
    
    return new ToolEvaluator(
      'tool_evaluator',
      'Tool Evaluator',
      actualConnector,
      ['tool_evaluation'],
      {
        modelType: 'openai',
        modelId: 'gpt-4.1-mini',
        maxTokens: 32000,
        temperature: .7
      },
      "Evaluador de herramientas que analiza y selecciona las mejores herramientas para una tarea."
    );
  }

  /**
   * Crea el procesador de targets
   */
  private createTargetProcessor(connector: PortkeyConnector): TargetProcessor {
    return new TargetProcessor(
      'target_processor',
      'Target Processor',
      connector,
      ['target_processing'],
      {
        modelType: 'openai',
        modelId: 'gpt-4.1',
        maxTokens: 32000,
        temperature: 0.7
      },
      "Procesador de targets que genera respuestas específicas para diferentes tipos de contenido.",
      `You are a target processor. Your role is to generate specific content based on defined targets.

Instructions:
1. Create content that precisely matches the requested targets.
2. Ensure all responses follow the specified format.
3. Be concise and direct in your responses.
4. Adapt your tone and style to the target requirements.
5. Your name is "Target Processor" - whenever asked about your name, identity or what you are, respond with this name.`
    );
  }
} 