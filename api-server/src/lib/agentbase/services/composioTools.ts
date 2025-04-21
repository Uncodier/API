/**
 * ComposioTools - Servicio para integrar herramientas de Composio
 * 
 * Este servicio proporciona una interfaz para acceder a las herramientas
 * de Composio y convertirlas al formato esperado por el ToolEvaluator.
 */

import { OpenAIToolSet } from "composio-core";

// Interfaces
interface ComposioToolsConfig {
  apiKey?: string;
  entityId?: string;
}

interface ComposioToolOptions {
  apps?: string[];
  integrationId?: string;
  tags?: string[];
  actions?: string[];
  useCase?: string;
  filterByAvailableApps?: boolean;
  useCaseLimit?: number;
}

/**
 * Clase principal de integración con Composio
 */
export class ComposioTools {
  private toolset: OpenAIToolSet | null = null;
  private config: ComposioToolsConfig;

  /**
   * Constructor
   * @param config Configuración opcional para Composio
   */
  constructor(config: ComposioToolsConfig = {}) {
    this.config = {
      apiKey: config.apiKey || process.env.COMPOSIO_API_KEY,
      entityId: config.entityId || 'default'
    };

    if (!this.config.apiKey) {
      console.warn('[ComposioTools] No COMPOSIO_API_KEY proporcionada. Configure la clave o pásela como parámetro.');
    }
  }

  /**
   * Inicializa la conexión con Composio
   */
  async initialize(): Promise<void> {
    try {
      if (!this.config.apiKey) {
        throw new Error('COMPOSIO_API_KEY es obligatorio para inicializar ComposioTools');
      }

      this.toolset = new OpenAIToolSet({});
      
      console.log(`[ComposioTools] Inicializado correctamente con entityId: ${this.config.entityId}`);
    } catch (error: any) {
      console.error(`[ComposioTools] Error al inicializar: ${error.message}`);
      throw error;
    }
  }

  /**
   * Obtiene herramientas de Composio
   * @param options Opciones para filtrar herramientas
   * @returns Lista de herramientas original de Composio
   */
  async getTools(options: ComposioToolOptions = {}): Promise<any[]> {
    try {
      if (!this.toolset) {
        await this.initialize();
      }

      if (!this.toolset) {
        throw new Error('No se pudo inicializar el toolset de Composio');
      }
      
      // Obtener herramientas de Composio
      const composioTools = await this.toolset.getTools({
        apps: options.apps,
        integrationId: options.integrationId,
        tags: options.tags,
        actions: options.actions,
        useCase: options.useCase,
        filterByAvailableApps: options.filterByAvailableApps,
        useCaseLimit: options.useCaseLimit
      });

      console.log(`[ComposioTools] Recibidas ${composioTools.length} herramientas de Composio`);
      
      // Devolver las herramientas sin transformación
      return composioTools;
    } catch (error: any) {
      console.error(`[ComposioTools] Error al obtener herramientas: ${error.message}`);
      throw error;
    }
  }

  /**
   * Convierte las herramientas a un string legible
   * @param tools Lista de herramientas 
   * @returns String formateado para fácil lectura humana
   */
  public toolsToReadableString(tools: any[]): string {
    if (!tools || tools.length === 0) {
      return '[ComposioTools] No hay herramientas disponibles';
    }

    let result = `HERRAMIENTAS COMPOSIO (${tools.length}):\n\n`;
    
    tools.forEach((tool, index) => {
      result += `TOOL ${index + 1}:\n`;
      result += JSON.stringify(tool, null, 2);
      result += '\n\n';
    });
    
    return result;
  }

  /**
   * Obtiene la representación legible de las herramientas como string
   * @param options Opciones para filtrar herramientas
   * @returns Representación de las herramientas como string
   */
  async getToolsAsString(options: ComposioToolOptions = {}): Promise<string> {
    const tools = await this.getTools(options);
    return this.toolsToReadableString(tools);
  }
} 