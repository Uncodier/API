/**
 * Utilidades para integración de Composio en cualquier punto del sistema
 * 
 * Estas funciones facilitan la integración de herramientas de Composio
 * con diferentes componentes de Agentbase.
 */
import { ComposioTools } from '../services/composioTools';
import { DbCommand } from '../models/types';

/**
 * Configuración para la integración de Composio
 */
export interface ComposioIntegrationConfig {
  enabled?: boolean;
  apiKey?: string;
  entityId?: string;
  apps?: string[];
  tags?: string[];
  integrationId?: string;
  filterByAvailableApps?: boolean;
}

// Variable global para configuración sin dependencias circulares
let globalConfig: ComposioIntegrationConfig = {
  enabled: true,
  apps : ["whatsapp"]
};

/**
 * Comprueba si la integración está habilitada
 */
export function isComposioEnabled(): boolean {
  return !!globalConfig.enabled;
}

/**
 * Obtiene la configuración actual
 */
export function getComposioConfig(): ComposioIntegrationConfig {
  return {...globalConfig};
}

/**
 * Configura la integración global de Composio
 */
export function configureComposio(config: ComposioIntegrationConfig): void {
  globalConfig = {
    ...globalConfig,
    ...config
  };
  
  console.log(`[ComposioConfig] Configuración actualizada:`, {
    enabled: globalConfig.enabled,
    apps: globalConfig.apps?.join(', '),
    tags: globalConfig.tags?.join(', '),
    entityId: globalConfig.entityId,
    integrationId: globalConfig.integrationId,
    filterByAvailableApps: globalConfig.filterByAvailableApps
  });
}

/**
 * Singleton para gestionar la configuración global de Composio
 * (Mantenida por compatibilidad)
 */
export class ComposioConfiguration {
  private static instance: ComposioConfiguration;
  
  private constructor() {}
  
  /**
   * Obtener la instancia única
   */
  public static getInstance(): ComposioConfiguration {
    if (!ComposioConfiguration.instance) {
      ComposioConfiguration.instance = new ComposioConfiguration();
    }
    return ComposioConfiguration.instance;
  }
  
  /**
   * Configurar la integración global
   */
  public configure(config: ComposioIntegrationConfig): void {
    configureComposio(config);
  }
  
  /**
   * Obtener la configuración actual
   */
  public getConfiguration(): ComposioIntegrationConfig {
    return getComposioConfig();
  }
  
  /**
   * Verificar si la integración está habilitada
   */
  public isEnabled(): boolean {
    return isComposioEnabled();
  }
}

/**
 * Enriquece un comando con herramientas de Composio
 * 
 * Esta función es el punto principal para integrar herramientas
 * de Composio en cualquier parte del sistema
 */
export async function enrichWithComposioTools(
  command: DbCommand,
  options?: ComposioIntegrationConfig
): Promise<DbCommand> {
  try {
    // Obtener configuración global si no se proporciona una específica
    const config = options || getComposioConfig();
    
    // Si no está habilitado, devolver el comando sin cambios
    if (!config.enabled) {
      return command;
    }
    
    console.log(`[ComposioIntegration] Enriqueciendo comando ${command.id} con herramientas de Composio`);
    
    // Instanciar servicio con configuración específica
    const composioTools = new ComposioTools({
      apiKey: config.apiKey,
      entityId: config.entityId
    });
    
    // Obtener herramientas
    const tools = await composioTools.getTools({
      apps: config.apps,
      tags: config.tags,
      integrationId: config.integrationId,
      filterByAvailableApps: config.filterByAvailableApps
    });
    
    console.log(`[ComposioIntegration] Obtenidas ${tools.length} herramientas de Composio`);
    
    // Si el comando no tiene tools, inicializar como array vacío
    if (!command.tools) {
      command.tools = [];
    }
    
    // Solo actualizar si se obtuvieron herramientas
    if (tools.length > 0) {
      // Añadir las herramientas al comando
      command.tools = [...command.tools, ...tools];
      
      console.log(`[ComposioIntegration] Comando enriquecido, ahora tiene ${command.tools.length} herramientas`);
      
      // Actualizar el comando en la base de datos
      try {
        // Importar CommandService dinámicamente para evitar dependencias circulares
        const { CommandService } = require('../services/command/CommandService');
        const commandService = new CommandService();
        
        // Actualizar solo las herramientas
        await commandService.updateCommand(command.id, { tools: command.tools });
        console.log(`[ComposioIntegration] ✅ Herramientas de Composio actualizadas en BD para comando ${command.id}`);
      } catch (dbError: any) {
        console.error(`[ComposioIntegration] ❌ Error al actualizar herramientas en BD: ${dbError.message}`);
        // No fallar si no se puede actualizar la BD, continuar con las herramientas en memoria
        console.log(`[ComposioIntegration] Continuando con herramientas solo en memoria`);
      }
    } else {
      console.log(`[ComposioIntegration] No se obtuvieron herramientas de Composio, comando sin cambios`);
    }
    
    return command;
  } catch (error: any) {
    console.error(`[ComposioIntegration] Error: ${error.message}`);
    return command;
  }
} 