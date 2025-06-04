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
  enabled: false,
  apps: []
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
 * Configura la integración global de Composio de manera segura
 * 
 * IMPORTANTE: Para evitar sobrecarga del sistema, Composio solo se habilitará
 * si se especifican apps concretas. Si se pasa enabled=true sin apps,
 * la configuración se ajustará automáticamente para evitar cargar miles de tools.
 */
export function configureComposio(config: ComposioIntegrationConfig): void {
  // Validación de seguridad: Si se habilita Composio sin apps específicas, mostrar advertencia
  if (config.enabled && (!config.apps || config.apps.length === 0)) {
    console.warn(`[ComposioConfig] ⚠️ ADVERTENCIA: Composio habilitado sin apps específicas.`);
    console.warn(`[ComposioConfig] ⚠️ Esto podría cargar miles de tools y causar problemas de rendimiento.`);
    console.warn(`[ComposioConfig] ⚠️ Deshabilitando automáticamente para evitar sobrecarga.`);
    
    // Deshabilitar automáticamente para evitar problemas
    config = {
      ...config,
      enabled: false
    };
  }
  
  globalConfig = {
    ...globalConfig,
    ...config
  };
  
  console.log(`[ComposioConfig] Configuración actualizada:`, {
    enabled: globalConfig.enabled,
    apps: globalConfig.apps?.join(', ') || 'ninguna',
    tags: globalConfig.tags?.join(', ') || 'ninguna',
    entityId: globalConfig.entityId || 'default',
    integrationId: globalConfig.integrationId || 'ninguna',
    filterByAvailableApps: globalConfig.filterByAvailableApps || false
  });
}

/**
 * Configura Composio con apps específicas de manera segura
 * Esta es la forma recomendada de habilitar Composio
 */
export function enableComposioWithApps(apps: string[], otherConfig?: Partial<ComposioIntegrationConfig>): void {
  if (!apps || apps.length === 0) {
    throw new Error('enableComposioWithApps requiere al menos una app específica');
  }
  
  configureComposio({
    enabled: true,
    apps,
    ...otherConfig
  });
}

/**
 * Deshabilita Composio completamente
 */
export function disableComposio(): void {
  configureComposio({
    enabled: false,
    apps: []
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
      console.log(`[ComposioIntegration] Composio está deshabilitado, saltando enriquecimiento`);
      return command;
    }
    
    // NUEVA VALIDACIÓN: Si no hay apps específicas, no cargar nada para evitar sobrecarga
    if (!config.apps || config.apps.length === 0) {
      console.log(`[ComposioIntegration] No hay apps específicas configuradas, saltando Composio para evitar sobrecarga`);
      return command;
    }
    
    console.log(`[ComposioIntegration] Enriqueciendo comando ${command.id} con herramientas de Composio`);
    console.log(`[ComposioIntegration] Apps configuradas: ${config.apps.join(', ')}`);
    
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