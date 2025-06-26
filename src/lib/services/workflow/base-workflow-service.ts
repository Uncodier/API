import { Connection, Client } from '@temporalio/client';

export interface WorkflowExecutionOptions {
  priority?: 'low' | 'medium' | 'high';
  async?: boolean;
  retryAttempts?: number;
  taskQueue?: string;
  workflowId?: string;
}

export interface WorkflowExecutionResponse {
  success: boolean;
  executionId?: string;
  workflowId?: string;
  runId?: string;
  status?: string;
  error?: {
    code: string;
    message: string;
  };
  // Additional properties for completed workflows
  data?: any;
  failure?: {
    message?: string;
    cause?: {
      message?: string;
      source?: string;
      stackTrace?: string;
    };
  };
  type?: string;
}

export abstract class BaseWorkflowService {
  protected client: Client | null = null;
  protected connection: Connection | null = null;

  protected constructor() {
    // Constructor protegido para clases abstractas
  }

  /**
   * Verifica la configuración de Temporal y determina si debe usarse local o cloud
   */
  public getTemporalConfig(): { 
    serverUrl: string; 
    namespace: string; 
    isConfigured: boolean;
    deploymentType: 'local' | 'cloud' | 'custom';
    environment: string | undefined;
    forcedByEnvironment: boolean;
    validationResult: {
      isValid: boolean;
      errors: string[];
      warnings: string[];
    };
  } {
    const serverUrl = this.getTemporalServerUrl();
    const namespace = this.getTemporalNamespace();
    const apiKey = this.getTemporalApiKey();
    const temporalEnv = this.getTemporalEnvironment();
    
    // Validación de configuración
    const validationResult = this.validateTemporalConfiguration();
    
    // Determinar tipo de deployment
    let deploymentType: 'local' | 'cloud' | 'custom' = 'local';
    let forcedByEnvironment = false;
    
    // Lógica de detección basada en configuración, no en environment
    if (apiKey && (serverUrl.includes('tmprl.cloud') || serverUrl.includes('temporal.cloud') || serverUrl.includes('aws.api.temporal.io'))) {
      deploymentType = 'cloud';
    } else if (serverUrl !== 'localhost:7233' && !apiKey) {
      deploymentType = 'custom';
    } else if (serverUrl === 'localhost:7233' || serverUrl.startsWith('127.0.0.1') || serverUrl.startsWith('0.0.0.0')) {
      deploymentType = 'local';
    }
    
    const isConfigured = validationResult.isValid && (
      deploymentType === 'cloud' || 
      deploymentType === 'custom' || 
      process.env.TEMPORAL_SERVER_URL !== undefined ||
      temporalEnv === 'development'
    );
    
    return {
      serverUrl,
      namespace,
      isConfigured,
      deploymentType,
      environment: temporalEnv,
      forcedByEnvironment,
      validationResult
    };
  }

  /**
   * Valida la configuración de Temporal
   */
  public validateTemporalConfiguration(): {
    isValid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];
    
    const serverUrl = this.getTemporalServerUrl();
    const namespace = this.getTemporalNamespace();
    const apiKey = this.getTemporalApiKey();
    const temporalEnv = this.getTemporalEnvironment();
    
    // Si TEMPORAL_ENV=development, validaciones simplificadas pero respetando configuración
    if (temporalEnv === 'development') {
      console.log('🧪 Modo desarrollo detectado - usando configuración especificada');
      
      // En modo desarrollo, solo verificar formatos básicos
      if (!this.isValidServerUrl(serverUrl)) {
        errors.push(`URL del servidor Temporal inválida: ${serverUrl}`);
      }
      
      if (!this.isValidNamespace(namespace)) {
        errors.push(`Namespace de Temporal inválido: ${namespace}`);
      }
      
      if (apiKey) {
        warnings.push('API Key configurada en modo desarrollo - asegúrate de que sea correcta');
      } else {
        warnings.push('No hay API Key configurada - usando servidor local o sin autenticación');
      }
      
      return {
        isValid: errors.length === 0,
        errors,
        warnings
      };
    }
    
    // Validaciones completas para otros entornos
    if (!this.isValidServerUrl(serverUrl)) {
      errors.push(`URL del servidor Temporal inválida: ${serverUrl}`);
    }
    
    if (!this.isValidNamespace(namespace)) {
      errors.push(`Namespace de Temporal inválido: ${namespace}`);
    }
    
    // Si es un servidor cloud, debe tener API key
    if ((serverUrl.includes('tmprl.cloud') || serverUrl.includes('temporal.cloud') || serverUrl.includes('aws.api.temporal.io')) && !apiKey) {
      errors.push('Servidor Temporal Cloud requiere API key');
    }
    
    // Si hay API key pero no es un servidor cloud conocido, avisar
    if (apiKey && !serverUrl.includes('tmprl.cloud') && !serverUrl.includes('temporal.cloud') && !serverUrl.includes('aws.api.temporal.io')) {
      warnings.push('API Key configurada para servidor que no parece ser Temporal Cloud');
    }
    
    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  protected isValidServerUrl(url: string): boolean {
    try {
      // Permitir URLs locales comunes para desarrollo
      if (url === 'localhost:7233' || url === '127.0.0.1:7233' || url === '0.0.0.0:7233') {
        return true;
      }
      
      // Para URLs completas, verificar que sean válidas
      const urlObj = new URL(url.startsWith('http') ? url : `http://${url}`);
      return urlObj.hostname.length > 0 && urlObj.port !== '';
    } catch {
      return false;
    }
  }

  protected isValidNamespace(namespace: string): boolean {
    // Namespace debe ser alfanumérico, con guiones y puntos permitidos
    return /^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$/.test(namespace) || namespace === 'default';
  }

  protected getTemporalServerUrl(): string {
    return process.env.TEMPORAL_SERVER_URL || 'localhost:7233';
  }

  protected getTemporalNamespace(): string {
    return process.env.TEMPORAL_NAMESPACE || 'default';
  }

  protected getTemporalApiKey(): string | undefined {
    return process.env.TEMPORAL_CLOUD_API_KEY;
  }

  protected getTemporalEnvironment(): string | undefined {
    return process.env.TEMPORAL_ENV;
  }

  public async testConnection(): Promise<{ 
    success: boolean; 
    error?: string; 
    config?: {
      deploymentType: 'local' | 'cloud' | 'custom';
      serverUrl: string;
      namespace: string;
      validationResult: {
        isValid: boolean;
        errors: string[];
        warnings: string[];
      };
    };
  }> {
    try {
      const config = this.getTemporalConfig();
      
      if (!config.validationResult.isValid) {
        return {
          success: false,
          error: `Configuración inválida: ${config.validationResult.errors.join(', ')}`,
          config: {
            deploymentType: config.deploymentType,
            serverUrl: config.serverUrl,
            namespace: config.namespace,
            validationResult: config.validationResult
          }
        };
      }

      // Intentar conectar
      const client = await this.initializeClient();
      
      // Test básico de conectividad
      const workflowService = client.workflowService;
      if (workflowService) {
        console.log('✅ Conexión a Temporal exitosa');
        return {
          success: true,
          config: {
            deploymentType: config.deploymentType,
            serverUrl: config.serverUrl,
            namespace: config.namespace,
            validationResult: config.validationResult
          }
        };
      } else {
        return {
          success: false,
          error: 'No se pudo acceder al servicio de workflows'
        };
      }
    } catch (error) {
      console.error('❌ Error al probar conexión a Temporal:', error);
      const config = this.getTemporalConfig();
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Error desconocido al conectar',
        config: {
          deploymentType: config.deploymentType,
          serverUrl: config.serverUrl,
          namespace: config.namespace,
          validationResult: config.validationResult
        }
      };
    }
  }

  protected async initializeClient(): Promise<Client> {
    if (this.client) {
      return this.client;
    }

    try {
      const config = this.getTemporalConfig();
      const serverUrl = config.serverUrl;
      const namespace = config.namespace;
      const apiKey = this.getTemporalApiKey();

      console.log(`🔌 Inicializando cliente Temporal...`);
      console.log(`📍 Servidor: ${serverUrl}`);
      console.log(`🏷️ Namespace: ${namespace}`);
      console.log(`🔑 API Key: ${apiKey ? 'Configurada' : 'No configurada'}`);
      console.log(`🌍 Entorno: ${config.environment || 'No especificado'}`);
      console.log(`📦 Tipo de deployment: ${config.deploymentType}`);

      const connectionOptions: any = {};

      // Configurar conexión según el tipo de deployment
      if (config.deploymentType === 'cloud' && apiKey) {
        // Configuración para Temporal Cloud
        console.log('☁️ Configurando para Temporal Cloud...');
        
        connectionOptions.address = serverUrl;
        connectionOptions.tls = {
          clientCertPair: undefined // Temporal Cloud usa API key
        };
        connectionOptions.metadata = {
          'temporal-namespace': namespace,
          'authorization': `Bearer ${apiKey}`
        };
      } else if (config.deploymentType === 'local' || config.deploymentType === 'custom') {
        // Configuración para servidor local o personalizado
        console.log(`🏠 Configurando para servidor ${config.deploymentType}...`);
        
        connectionOptions.address = serverUrl;
        
        // Para servidores locales (incluyendo IPs privadas), no usar TLS por defecto
        // Solo usar TLS si está explícitamente configurado
        const isPrivateIP = serverUrl.includes('localhost') || 
                           serverUrl.includes('127.0.0.1') || 
                           serverUrl.includes('0.0.0.0') ||
                           serverUrl.includes('192.168.') ||
                           serverUrl.includes('10.') ||
                           serverUrl.match(/172\.(1[6-9]|2[0-9]|3[0-1])\./);
        
        const forceTLS = process.env.TEMPORAL_FORCE_TLS === 'true';
        
        if (!isPrivateIP || forceTLS) {
          console.log('🔒 Habilitando TLS para servidor externo...');
          connectionOptions.tls = {}; // TLS básico sin certificados cliente
        } else {
          console.log('🔓 Sin TLS para servidor local/privado...');
          // No TLS para IPs privadas por defecto
        }
      }

      // Crear conexión
      this.connection = await Connection.connect(connectionOptions);
      console.log('✅ Conexión a Temporal establecida');

      // Crear cliente
      this.client = new Client({
        connection: this.connection,
        namespace: namespace,
      });

      console.log('✅ Cliente Temporal inicializado correctamente');
      return this.client;

    } catch (error) {
      console.error('❌ Error al inicializar cliente Temporal:', error);
      
      // Limpiar en caso de error
      this.client = null;
      this.connection = null;
      
      throw new Error(`Error al conectar con Temporal: ${error instanceof Error ? error.message : 'Error desconocido'}`);
    }
  }

  public async closeConnection(): Promise<void> {
    try {
      if (this.connection) {
        await this.connection.close();
        this.connection = null;
        console.log('✅ Conexión a Temporal cerrada');
      }
      this.client = null;
    } catch (error) {
      console.error('❌ Error al cerrar conexión a Temporal:', error);
    }
  }

  public async executeWorkflow(workflowType: string, args: any, options?: WorkflowExecutionOptions): Promise<WorkflowExecutionResponse> {
    try {
      const client = await this.initializeClient();
      
      const workflowId = options?.workflowId || `${workflowType}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const taskQueue = options?.taskQueue || process.env.WORKFLOW_TASK_QUEUE || 'default';

      console.log(`🚀 Ejecutando workflow: ${workflowType} con ID: ${workflowId}`);

      // Si es asíncrono, solo iniciar el workflow
      if (options?.async !== false) {
        const handle = await client.workflow.start(workflowType, {
          args: [args],
          taskQueue,
          workflowId,
        });

        console.log(`✅ Workflow iniciado: ${handle.workflowId}, runId: ${handle.firstExecutionRunId}`);

        return {
          success: true,
          executionId: handle.firstExecutionRunId,
          workflowId: handle.workflowId,
          runId: handle.firstExecutionRunId,
          status: 'running'
        };
      } else {
        // Ejecutar workflow y esperar resultado
        const result = await client.workflow.execute(workflowType, {
          args: [args],
          taskQueue,
          workflowId,
        });

        console.log(`✅ Workflow completado: ${workflowId}`);

        return {
          success: true,
          workflowId,
          status: 'completed',
          data: result
        };
      }

    } catch (error) {
      console.error(`❌ Error al ejecutar workflow ${workflowType}:`, error);
      return {
        success: false,
        error: {
          code: 'WORKFLOW_EXECUTION_ERROR',
          message: error instanceof Error ? error.message : 'Error desconocido al ejecutar workflow'
        }
      };
    }
  }

  public async getWorkflowStatus(workflowId: string, runId?: string): Promise<WorkflowExecutionResponse> {
    try {
      const client = await this.initializeClient();
      const handle = client.workflow.getHandle(workflowId, runId);
      
      const status = await handle.describe();
      
      return {
        success: true,
        workflowId: status.workflowId,
        runId: status.runId,
        status: status.status.name,
        type: status.type || 'unknown'
      };

    } catch (error) {
      console.error(`❌ Error al obtener estado del workflow ${workflowId}:`, error);
      return {
        success: false,
        error: {
          code: 'WORKFLOW_STATUS_ERROR',
          message: error instanceof Error ? error.message : 'Error desconocido al obtener estado del workflow'
        }
      };
    }
  }

  public async cancelWorkflow(workflowId: string, runId?: string): Promise<WorkflowExecutionResponse> {
    try {
      const client = await this.initializeClient();
      const handle = client.workflow.getHandle(workflowId, runId);
      
      await handle.cancel();
      
      return {
        success: true,
        workflowId,
        runId,
        status: 'cancelled'
      };

    } catch (error) {
      console.error(`❌ Error al cancelar workflow ${workflowId}:`, error);
      return {
        success: false,
        error: {
          code: 'WORKFLOW_CANCEL_ERROR',
          message: error instanceof Error ? error.message : 'Error desconocido al cancelar workflow'
        }
      };
    }
  }
} 