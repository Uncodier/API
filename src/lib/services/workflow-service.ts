import { Connection, Client } from '@temporalio/client';

interface WorkflowExecutionArgs {
  email: string;
  from: string;
  subject: string;
  message: string;
  site_id: string; // Requerido para obtener configuración SMTP
  // Parámetros opcionales para logging
  agent_id?: string;
  conversation_id?: string;
  lead_id?: string;
}

interface WorkflowExecutionOptions {
  priority?: 'low' | 'medium' | 'high';
  async?: boolean;
  retryAttempts?: number;
  taskQueue?: string;
  workflowId?: string;
}

interface WorkflowExecutionResponse {
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

// Interfaz para los datos de análisis
interface AnalysisData {
  summary: string;
  insights: string[];
  sentiment: "positive" | "negative" | "neutral";
  priority: "high" | "medium" | "low";
  action_items: string[];
  response: string[];
  lead_extraction: {
    contact_info: {
      name: string | null;
      email: string | null;
      phone: string | null;
      company: string | null;
    };
    intent: "inquiry" | "complaint" | "purchase" | "support" | "partnership" | "demo_request";
    requirements: string[];
    budget_indication: string | null;
    timeline: string | null;
    decision_maker: "yes" | "no" | "unknown";
    source: "website" | "referral" | "social_media" | "advertising" | "cold_outreach";
  };
  commercial_opportunity: {
    requires_response: boolean;
    response_type: "commercial" | "support" | "informational" | "follow_up";
    priority_level: "high" | "medium" | "low";
    suggested_actions: string[];
    potential_value: "high" | "medium" | "low" | "unknown";
    next_steps: string[];
  };
}

// Interfaz para programar soporte al cliente
interface ScheduleCustomerSupportParams {
  analysisArray: AnalysisData[];
  site_id: string;
  userId?: string;      //requerido
}

// Nueva interfaz para el workflow de WhatsApp
interface WhatsAppMessageWorkflowArgs {
  phoneNumber: string;
  messageContent: string;
  businessAccountId: string;
  messageId: string;
  conversationId: string | null; // Permitir null para nuevas conversaciones
  agentId: string;
  siteId: string;
  userId?: string; // ID del usuario dueño del sitio
  senderName?: string; // Nombre del perfil de WhatsApp del remitente
  visitorId?: string;
  leadId?: string;
}

export class WorkflowService {
  private static instance: WorkflowService;
  private client: Client | null = null;
  private connection: Connection | null = null;

  private constructor() {
    // Constructor privado para singleton
  }

  public static getInstance(): WorkflowService {
    if (!WorkflowService.instance) {
      WorkflowService.instance = new WorkflowService();
    }
    return WorkflowService.instance;
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
      
      // Informar sobre la configuración que se está usando
      if (process.env.TEMPORAL_SERVER_URL) {
        console.log(`📍 Usando servidor configurado: ${serverUrl}`);
      } else {
        console.log(`📍 Usando servidor por defecto: ${serverUrl}`);
      }
      
      if (process.env.TEMPORAL_NAMESPACE) {
        console.log(`📁 Usando namespace configurado: ${namespace}`);
      } else {
        console.log(`📁 Usando namespace por defecto: ${namespace}`);
      }
      
      return {
        isValid: errors.length === 0,
        errors,
        warnings
      };
    }
    
    // Validaciones completas para otros entornos
    // Validaciones básicas
    if (!serverUrl) {
      errors.push('TEMPORAL_SERVER_URL no está configurado');
    }
    
    if (!namespace) {
      errors.push('TEMPORAL_NAMESPACE no está configurado');
    }
    
    // Validaciones específicas para Temporal Cloud
    if (serverUrl.includes('tmprl.cloud') || serverUrl.includes('temporal.cloud') || serverUrl.includes('aws.api.temporal.io')) {
      if (!apiKey) {
        errors.push('TEMPORAL_CLOUD_API_KEY es requerido para Temporal Cloud');
      }
      if (namespace === 'default') {
        warnings.push('Se recomienda usar un namespace específico para Temporal Cloud en lugar de "default"');
      }
    }
    
    // Validaciones para servidor local
    if (serverUrl === 'localhost:7233' || serverUrl.startsWith('127.0.0.1')) {
      if (apiKey) {
        warnings.push('TEMPORAL_CLOUD_API_KEY está configurado pero se está usando servidor local');
      }
      if (process.env.NODE_ENV === 'production') {
        warnings.push('Se está usando servidor local en entorno de producción');
      }
    }
    
    // Validaciones de formato
    if (!this.isValidServerUrl(serverUrl)) {
      errors.push(`URL del servidor Temporal inválida: ${serverUrl}`);
    }
    
    if (!this.isValidNamespace(namespace)) {
      errors.push(`Namespace de Temporal inválido: ${namespace}`);
    }
    
    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Valida el formato de la URL del servidor
   */
  private isValidServerUrl(url: string): boolean {
    // Permitir localhost, IPs locales y dominios válidos
    const localHostPatterns = [
      /^localhost:\d+$/,
      /^127\.0\.0\.1:\d+$/,
      /^0\.0\.0\.0:\d+$/
    ];
    
    const cloudPatterns = [
      /^[\w-]+\.tmprl\.cloud:\d+$/,
      /^[\w-]+\.temporal\.cloud:\d+$/,
      /^[\w-]+\.aws\.api\.temporal\.io:\d+$/
    ];
    
    const customPatterns = [
      /^[\w.-]+:\d+$/
    ];
    
    return localHostPatterns.some(pattern => pattern.test(url)) ||
           cloudPatterns.some(pattern => pattern.test(url)) ||
           customPatterns.some(pattern => pattern.test(url));
  }

  /**
   * Valida el formato del namespace
   */
  private isValidNamespace(namespace: string): boolean {
    // Namespace debe ser alfanumérico con guiones, puntos y guiones bajos, sin espacios
    // Permite formato de Temporal Cloud como "namespace.suffix"
    return /^[a-zA-Z0-9._-]+$/.test(namespace) && namespace.length >= 1 && namespace.length <= 64;
  }

  /**
   * Obtiene la URL del servidor de Temporal
   */
  private getTemporalServerUrl(): string {
    // Usar TEMPORAL_SERVER_URL si está configurado, incluso en desarrollo
    return process.env.TEMPORAL_SERVER_URL || 'localhost:7233';
  }

  /**
   * Obtiene el namespace de Temporal
   */
  private getTemporalNamespace(): string {
    // Usar TEMPORAL_NAMESPACE si está configurado, incluso en desarrollo
    return process.env.TEMPORAL_NAMESPACE || 'default';
  }

  /**
   * Obtiene el API key de Temporal Cloud
   */
  private getTemporalApiKey(): string | undefined {
    // Usar TEMPORAL_CLOUD_API_KEY si está configurado, incluso en desarrollo
    return process.env.TEMPORAL_CLOUD_API_KEY;
  }

  /**
   * Obtiene el entorno de Temporal configurado
   */
  private getTemporalEnvironment(): string | undefined {
    return process.env.TEMPORAL_ENV;
  }

  /**
   * Verifica si el servidor Temporal está disponible
   */
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
      // Obtener y validar configuración
      const config = this.getTemporalConfig();
      
      console.log(`🔍 Probando conexión a Temporal (${config.deploymentType.toUpperCase()})`);
      console.log(`📍 Servidor: ${config.serverUrl}`);
      console.log(`📁 Namespace: ${config.namespace}`);
      
      // Mostrar warnings si existen
      if (config.validationResult.warnings.length > 0) {
        console.warn('⚠️ Advertencias de configuración:');
        config.validationResult.warnings.forEach(warning => {
          console.warn(`   - ${warning}`);
        });
      }
      
      // Verificar si la configuración es válida antes de intentar conectar
      if (!config.validationResult.isValid) {
        const errorMessage = `Configuración de Temporal inválida: ${config.validationResult.errors.join(', ')}`;
        console.error('❌', errorMessage);
        return {
          success: false,
          error: errorMessage,
          config
        };
      }
      
      const apiKey = this.getTemporalApiKey();
      console.log(`🔑 API Key configurado: ${apiKey ? 'Sí' : 'No'}`);
      
      // Configuración de conexión según el tipo de deployment
      const connectionOptions: any = {
        address: config.serverUrl,
        connectTimeout: '5s',
      };

      switch (config.deploymentType) {
        case 'cloud':
          connectionOptions.tls = true;
          connectionOptions.apiKey = apiKey;
          connectionOptions.metadata = {
            'temporal-namespace': config.namespace,
          };
          console.log('🌐 Configurando para Temporal Cloud con TLS y API Key');
          break;
          
        case 'custom':
          // Para servidores custom, intentar TLS primero, luego sin TLS
          connectionOptions.tls = config.serverUrl.includes('https') || !config.serverUrl.includes('localhost');
          console.log(`🔧 Configurando para servidor personalizado ${connectionOptions.tls ? 'con' : 'sin'} TLS`);
          break;
          
        case 'local':
        default:
          connectionOptions.tls = false;
          console.log('🏠 Configurando para servidor local sin TLS');
          break;
      }

      const testConnection = await Connection.connect(connectionOptions);
      
      await testConnection.close();
      console.log(`✅ Conexión a Temporal ${config.deploymentType.toUpperCase()} exitosa`);
      
      return { 
        success: true,
        config
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
      console.error('❌ Error al probar conexión a Temporal:', errorMessage);
      
      // Intentar dar sugerencias basadas en el error
      let enhancedError = errorMessage;
      if (errorMessage.includes('ECONNREFUSED')) {
        enhancedError += ' - Verifica que el servidor Temporal esté ejecutándose y la URL sea correcta';
      } else if (errorMessage.includes('certificate')) {
        enhancedError += ' - Problema con certificados TLS. Verifica la configuración de seguridad';
      } else if (errorMessage.includes('unauthorized') || errorMessage.includes('authentication')) {
        enhancedError += ' - Problema de autenticación. Verifica el API Key de Temporal Cloud';
      }
      
      return {
        success: false,
        error: enhancedError,
        config: this.getTemporalConfig()
      };
    }
  }

  /**
   * Inicializa la conexión con Temporal
   */
  private async initializeClient(): Promise<Client> {
    if (this.client) {
      return this.client;
    }

    try {
      // Obtener y validar configuración
      const config = this.getTemporalConfig();
      
      console.log(`🔌 Inicializando cliente Temporal (${config.deploymentType.toUpperCase()})`);
      console.log(`📍 Servidor: ${config.serverUrl}`);
      console.log(`📁 Namespace: ${config.namespace}`);
      
      // Mostrar warnings si existen
      if (config.validationResult.warnings.length > 0) {
        console.warn('⚠️ Advertencias de configuración:');
        config.validationResult.warnings.forEach(warning => {
          console.warn(`   - ${warning}`);
        });
      }
      
      // Verificar si la configuración es válida antes de intentar conectar
      if (!config.validationResult.isValid) {
        const errorMessage = `No se puede inicializar Temporal - Configuración inválida: ${config.validationResult.errors.join(', ')}`;
        console.error('❌', errorMessage);
        throw new Error(errorMessage);
      }

      const apiKey = this.getTemporalApiKey();
      console.log(`🔑 API Key configurado: ${apiKey ? 'Sí' : 'No'}`);

      // Configuración de conexión según el tipo de deployment
      const connectionOptions: any = {
        address: config.serverUrl,
        connectTimeout: '10s',
      };

      switch (config.deploymentType) {
        case 'cloud':
          connectionOptions.tls = true;
          connectionOptions.apiKey = apiKey;
          connectionOptions.metadata = {
            'temporal-namespace': config.namespace,
          };
          console.log('🌐 Configurando cliente para Temporal Cloud con TLS y API Key');
          break;
          
        case 'custom':
          // Para servidores custom, determinar TLS automáticamente
          connectionOptions.tls = config.serverUrl.includes('https') || !config.serverUrl.includes('localhost');
          if (apiKey) {
            connectionOptions.apiKey = apiKey;
            connectionOptions.metadata = {
              'temporal-namespace': config.namespace,
            };
          }
          console.log(`🔧 Configurando cliente para servidor personalizado ${connectionOptions.tls ? 'con' : 'sin'} TLS`);
          break;
          
        case 'local':
        default:
          connectionOptions.tls = false;
          console.log('🏠 Configurando cliente para servidor local sin TLS');
          break;
      }

      this.connection = await Connection.connect(connectionOptions);

      this.client = new Client({
        connection: this.connection,
        namespace: config.namespace,
      });

      console.log(`✅ Cliente Temporal ${config.deploymentType.toUpperCase()} inicializado exitosamente`);
      return this.client;

    } catch (error) {
      console.error('❌ Error al inicializar cliente de Temporal:', error);
      
      const config = this.getTemporalConfig();
      console.error('📍 Configuración actual:');
      console.error(`   - Tipo: ${config.deploymentType}`);
      console.error(`   - Servidor: ${config.serverUrl}`);
      console.error(`   - Namespace: ${config.namespace}`);
      console.error(`   - API Key: ${this.getTemporalApiKey() ? 'Configurado' : 'No configurado'}`);
      
      if (config.validationResult.errors.length > 0) {
        console.error('📍 Errores de configuración:');
        config.validationResult.errors.forEach(err => {
          console.error(`   - ${err}`);
        });
      }
      
      // Intentar logging adicional para diagnosticar el problema
      if (error instanceof Error) {
        console.error('📍 Mensaje de error:', error.message);
        
        // Dar sugerencias específicas según el tipo de error
        if (error.message.includes('ECONNREFUSED')) {
          console.error('💡 Sugerencia: Verifica que el servidor Temporal esté ejecutándose');
          if (config.deploymentType === 'local') {
            console.error('   Para servidor local, ejecuta: temporal server start-dev');
          }
        } else if (error.message.includes('certificate') || error.message.includes('tls')) {
          console.error('💡 Sugerencia: Problema de TLS/SSL. Verifica la configuración de certificados');
        } else if (error.message.includes('unauthorized') || error.message.includes('authentication')) {
          console.error('💡 Sugerencia: Problema de autenticación. Verifica el API Key de Temporal Cloud');
        }
      }
      
      throw error;
    }
  }

  /**
   * Cierra la conexión con Temporal
   */
  public async closeConnection(): Promise<void> {
    if (this.connection) {
      await this.connection.close();
      this.connection = null;
      this.client = null;
      console.log('🔌 Conexión con Temporal cerrada');
    }
  }

  /**
   * Obtiene un reporte completo del estado de la configuración de Temporal
   */
  public getConfigurationReport(): {
    deploymentType: 'local' | 'cloud' | 'custom';
    serverUrl: string;
    namespace: string;
    apiKeyConfigured: boolean;
    environment: string | undefined;
    forcedByEnvironment: boolean;
    environmentVariables: {
      TEMPORAL_ENV?: string;
      TEMPORAL_SERVER_URL?: string;
      TEMPORAL_NAMESPACE?: string;
      TEMPORAL_CLOUD_API_KEY?: string;
      NODE_ENV?: string;
    };
    validation: {
      isValid: boolean;
      errors: string[];
      warnings: string[];
    };
    recommendations: string[];
  } {
    const config = this.getTemporalConfig();
    const apiKey = this.getTemporalApiKey();
    
    const recommendations: string[] = [];
    
    // Recomendaciones específicas para TEMPORAL_ENV=development
    if (config.environment === 'development') {
      recommendations.push('🧪 Modo desarrollo activo - configuración automática para localhost');
      if (process.env.NODE_ENV === 'production') {
        recommendations.push('⚠️ TEMPORAL_ENV=development en NODE_ENV=production - revisar configuración');
      }
    } else {
      // Generar recomendaciones normales
      if (config.deploymentType === 'local' && process.env.NODE_ENV === 'production') {
        recommendations.push('⚠️ Se recomienda usar Temporal Cloud o un servidor dedicado en producción');
      }
      
      if (config.deploymentType === 'cloud' && !apiKey) {
        recommendations.push('❌ Se requiere TEMPORAL_CLOUD_API_KEY para Temporal Cloud');
      }
      
      if (config.namespace === 'default' && config.deploymentType === 'cloud') {
        recommendations.push('💡 Se recomienda usar un namespace personalizado en lugar de "default"');
      }
      
      if (!process.env.WORKFLOW_TASK_QUEUE) {
        recommendations.push('💡 Considera configurar WORKFLOW_TASK_QUEUE para mejor organización');
      }
      
      // Sugerir uso de TEMPORAL_ENV para desarrollo
      if (config.deploymentType === 'local' && !config.environment && process.env.NODE_ENV === 'development') {
        recommendations.push('💡 Para desarrollo, considera usar TEMPORAL_ENV=development para configuración automática');
      }
    }
    
    return {
      deploymentType: config.deploymentType,
      serverUrl: config.serverUrl,
      namespace: config.namespace,
      apiKeyConfigured: !!apiKey,
      environment: config.environment,
      forcedByEnvironment: config.forcedByEnvironment,
      environmentVariables: {
        TEMPORAL_ENV: process.env.TEMPORAL_ENV,
        TEMPORAL_SERVER_URL: process.env.TEMPORAL_SERVER_URL,
        TEMPORAL_NAMESPACE: process.env.TEMPORAL_NAMESPACE,
        TEMPORAL_CLOUD_API_KEY: process.env.TEMPORAL_CLOUD_API_KEY ? '***configurado***' : undefined,
        NODE_ENV: process.env.NODE_ENV
      },
      validation: config.validationResult,
      recommendations
    };
  }

  /**
   * Detecta automáticamente la mejor configuración basada en el entorno
   */
  public getAutoDetectedConfiguration(): {
    suggestedType: 'local' | 'cloud' | 'custom';
    suggestedSettings: {
      TEMPORAL_ENV?: string;
      TEMPORAL_SERVER_URL?: string;
      TEMPORAL_NAMESPACE?: string;
      TEMPORAL_CLOUD_API_KEY?: string;
    };
    reasoning: string[];
  } {
    const reasoning: string[] = [];
    let suggestedType: 'local' | 'cloud' | 'custom' = 'local';
    const suggestedSettings: any = {};
    
    // Detectar entorno
    const isProduction = process.env.NODE_ENV === 'production';
    const isDevelopment = process.env.NODE_ENV === 'development';
    const hasTemporalEnv = !!process.env.TEMPORAL_ENV;
    const hasCloudApiKey = !!process.env.TEMPORAL_CLOUD_API_KEY;
    const hasCustomUrl = process.env.TEMPORAL_SERVER_URL && !process.env.TEMPORAL_SERVER_URL.includes('localhost');
    
    // Si ya hay TEMPORAL_ENV=development, sugerir mantenerlo
    if (process.env.TEMPORAL_ENV === 'development') {
      suggestedType = 'local';
      suggestedSettings.TEMPORAL_ENV = 'development';
      reasoning.push('✅ TEMPORAL_ENV=development detectado - configuración automática activa');
      reasoning.push('Todas las otras configuraciones se ignoran automáticamente');
      
      return {
        suggestedType,
        suggestedSettings,
        reasoning
      };
    }
    
    // Si es desarrollo y no hay TEMPORAL_ENV, sugerirlo
    if (isDevelopment && !hasTemporalEnv && !hasCloudApiKey && !hasCustomUrl) {
      suggestedType = 'local';
      suggestedSettings.TEMPORAL_ENV = 'development';
      reasoning.push('💡 NODE_ENV=development detectado');
      reasoning.push('🎯 RECOMENDACIÓN: Usar TEMPORAL_ENV=development para configuración automática');
      reasoning.push('Esto configura automáticamente localhost:7233 con namespace default');
      
      return {
        suggestedType,
        suggestedSettings,
        reasoning
      };
    }
    
    // Lógica normal para otros casos
    if (hasCloudApiKey) {
      suggestedType = 'cloud';
      suggestedSettings.TEMPORAL_CLOUD_API_KEY = process.env.TEMPORAL_CLOUD_API_KEY;
      
      if (!process.env.TEMPORAL_SERVER_URL || process.env.TEMPORAL_SERVER_URL.includes('localhost')) {
        suggestedSettings.TEMPORAL_SERVER_URL = 'tu-namespace.tmprl.cloud:7233';
        reasoning.push('Detectado API Key de Cloud, sugiriendo URL de Temporal Cloud');
      }
      
      if (!process.env.TEMPORAL_NAMESPACE || process.env.TEMPORAL_NAMESPACE === 'default') {
        suggestedSettings.TEMPORAL_NAMESPACE = 'tu-namespace-de-produccion';
        reasoning.push('Se recomienda un namespace específico para Temporal Cloud');
      }
    } else if (hasCustomUrl) {
      suggestedType = 'custom';
      reasoning.push('Detectada URL personalizada sin API Key de Cloud');
      
      if (!process.env.TEMPORAL_NAMESPACE || process.env.TEMPORAL_NAMESPACE === 'default') {
        suggestedSettings.TEMPORAL_NAMESPACE = 'custom-namespace';
        reasoning.push('Se recomienda un namespace personalizado para servidor custom');
      }
    } else {
      suggestedType = 'local';
      reasoning.push('No se detectó configuración cloud o custom, sugiriendo setup local');
      
      if (!process.env.TEMPORAL_SERVER_URL) {
        suggestedSettings.TEMPORAL_SERVER_URL = 'localhost:7233';
        reasoning.push('Configurando URL local por defecto');
      }
      
      if (!process.env.TEMPORAL_NAMESPACE) {
        suggestedSettings.TEMPORAL_NAMESPACE = 'default';
        reasoning.push('Usando namespace default para desarrollo local');
      }
    }
    
    if (isProduction && suggestedType === 'local') {
      reasoning.push('⚠️ ADVERTENCIA: Entorno de producción detectado pero configuración local sugerida');
      reasoning.push('💡 Considera migrar a Temporal Cloud para producción');
    }
    
    return {
      suggestedType,
      suggestedSettings,
      reasoning
    };
  }

  /**
   * Ejecuta un workflow para enviar email desde un agente
   */
  public async sendEmailFromAgent(args: WorkflowExecutionArgs, options?: WorkflowExecutionOptions): Promise<WorkflowExecutionResponse> {
    try {
      // Validar argumentos requeridos
      if (!args.email || !args.from || !args.subject || !args.message || !args.site_id) {
        return {
          success: false,
          error: {
            code: 'INVALID_ARGUMENTS',
            message: 'Se requieren email, from, subject, message y site_id para enviar el email'
          }
        };
      }

      const client = await this.initializeClient();
      
      const workflowId = options?.workflowId || `send-email-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const taskQueue = options?.taskQueue || process.env.WORKFLOW_TASK_QUEUE || 'default';

      console.log(`📧 Iniciando workflow de email: ${workflowId}`);
      console.log(`📋 Args:`, JSON.stringify(args, null, 2));
      console.log(`🔧 Using task queue: ${taskQueue}`);

      // Aquí se debería importar el workflow específico, por ahora uso un nombre genérico
      const handle = await client.workflow.start('sendEmailFromAgent', {
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

    } catch (error) {
      console.error('❌ Error al ejecutar workflow de email:', error);
      return {
        success: false,
        error: {
          code: 'WORKFLOW_EXECUTION_ERROR',
          message: error instanceof Error ? error.message : 'Error desconocido al ejecutar workflow'
        }
      };
    }
  }

  /**
   * Ejecuta cualquier tipo de workflow genérico
   */
  public async executeWorkflow(workflowType: string, args: any, options?: WorkflowExecutionOptions): Promise<WorkflowExecutionResponse> {
    try {
      const client = await this.initializeClient();
      
      const workflowId = options?.workflowId || `${workflowType}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const taskQueue = options?.taskQueue || process.env.WORKFLOW_TASK_QUEUE || 'default';
      const isAsync = options?.async !== false; // Por defecto es asíncrono, pero puede ser síncrono

      console.log(`🔄 Ejecutando workflow ${workflowType}: ${workflowId}`);
      console.log(`🔧 Using task queue: ${taskQueue}`);
      console.log(`⏱️ Modo: ${isAsync ? 'Asíncrono' : 'Síncrono (esperando resultado)'}`);

      const handle = await client.workflow.start(workflowType, {
        args: [args],
        taskQueue,
        workflowId,
      });

      console.log(`✅ Workflow ${workflowType} iniciado: ${handle.workflowId}, runId: ${handle.firstExecutionRunId}`);

      // Si es asíncrono, retornar inmediatamente
      if (isAsync) {
        return {
          success: true,
          executionId: handle.firstExecutionRunId,
          workflowId: handle.workflowId,
          runId: handle.firstExecutionRunId,
          status: 'running'
        };
      }

      // Si es síncrono, esperar el resultado del workflow
      try {
        console.log(`⏳ Esperando resultado del workflow ${workflowType}...`);
        const result = await handle.result();
        
        console.log(`✅ Workflow ${workflowType} completado exitosamente`);
        
        return {
          success: true,
          executionId: handle.firstExecutionRunId,
          workflowId: handle.workflowId,
          runId: handle.firstExecutionRunId,
          status: 'completed',
          data: result
        };
        
      } catch (workflowError: any) {
        console.error(`❌ Workflow ${workflowType} falló:`, workflowError);
        
        // Extraer información detallada del error de Temporal
        let errorResponse: WorkflowExecutionResponse = {
          success: false,
          executionId: handle.firstExecutionRunId,
          workflowId: handle.workflowId,
          runId: handle.firstExecutionRunId,
          status: 'failed',
          error: {
            code: 'WORKFLOW_EXECUTION_FAILED',
            message: workflowError.message || 'Workflow execution failed'
          }
        };

        // Si hay información adicional de falla de Temporal, incluirla
        if (workflowError.cause) {
          errorResponse.failure = {
            message: workflowError.message,
            cause: {
              message: workflowError.cause.message,
              source: workflowError.cause.source,
              stackTrace: workflowError.cause.stackTrace
            }
          };
        }

        // Si hay información de tipo de falla
        if (workflowError.type) {
          errorResponse.type = workflowError.type;
        }

        return errorResponse;
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

  /**
   * Obtiene el estado de un workflow
   */
  public async getWorkflowStatus(workflowId: string, runId?: string): Promise<WorkflowExecutionResponse> {
    try {
      const client = await this.initializeClient();
      
      const handle = client.workflow.getHandle(workflowId, runId);
      const description = await handle.describe();

      return {
        success: true,
        workflowId: description.workflowId,
        runId: description.runId,
        status: description.status.name.toLowerCase()
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

  /**
   * Cancela un workflow
   */
  public async cancelWorkflow(workflowId: string, runId?: string): Promise<WorkflowExecutionResponse> {
    try {
      const client = await this.initializeClient();
      
      const handle = client.workflow.getHandle(workflowId, runId);
      await handle.cancel();

      console.log(`🚫 Workflow cancelado: ${workflowId}`);

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

  /**
   * Programa un workflow de customer support con análisis de emails
   */
  public async scheduleCustomerSupport(params: ScheduleCustomerSupportParams, options?: WorkflowExecutionOptions): Promise<WorkflowExecutionResponse> {
    try {
      // Validar argumentos requeridos
      if (!params.analysisArray || !Array.isArray(params.analysisArray)) {
        return {
          success: false,
          error: {
            code: 'INVALID_ARGUMENTS',
            message: 'Se requiere analysisArray como un arreglo válido'
          }
        };
      }

      if (!params.site_id) {
        return {
          success: false,
          error: {
            code: 'INVALID_ARGUMENTS',
            message: 'Se requiere site_id para programar el soporte al cliente'
          }
        };
      }

      if (!params.userId) {
        return {
          success: false,
          error: {
            code: 'INVALID_ARGUMENTS',
            message: 'Se requiere userId para programar el soporte al cliente'
          }
        };
      }

      const client = await this.initializeClient();
      
      const workflowId = options?.workflowId || `customer-support-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const taskQueue = options?.taskQueue || process.env.WORKFLOW_TASK_QUEUE || 'default';

      console.log(`🎯 Programando workflow de customer support: ${workflowId}`);
      console.log(`📊 Análisis incluidos: ${params.analysisArray.length}`);
      console.log(`🏢 Site ID: ${params.site_id}`);
      console.log(`👤 User ID: ${params.userId}`);

      const handle = await client.workflow.start('scheduleCustomerSupportMessagesWorkflow', {
        args: [params],
        taskQueue,
        workflowId,
      });

      console.log(`✅ Workflow de customer support programado: ${handle.workflowId}, runId: ${handle.firstExecutionRunId}`);

      return {
        success: true,
        executionId: handle.firstExecutionRunId,
        workflowId: handle.workflowId,
        runId: handle.firstExecutionRunId,
        status: 'running'
      };

    } catch (error) {
      console.error('❌ Error al programar workflow de customer support:', error);
      return {
        success: false,
        error: {
          code: 'WORKFLOW_EXECUTION_ERROR',
          message: error instanceof Error ? error.message : 'Error desconocido al programar workflow de customer support'
        }
      };
    }
  }

  /**
   * Inicia el workflow para procesar y responder mensajes de WhatsApp
   */
  public async answerWhatsappMessage(args: WhatsAppMessageWorkflowArgs, options?: WorkflowExecutionOptions): Promise<WorkflowExecutionResponse> {
    try {
      // Validar argumentos requeridos (conversationId puede ser null o vacío para nuevas conversaciones)
      if (!args.phoneNumber || !args.messageContent || !args.businessAccountId || !args.messageId || !args.agentId || !args.siteId) {
        return {
          success: false,
          error: {
            code: 'INVALID_ARGUMENTS',
            message: 'Se requieren phoneNumber, messageContent, businessAccountId, messageId, agentId y siteId para procesar el mensaje de WhatsApp'
          }
        };
      }

      const client = await this.initializeClient();
      
      const workflowId = options?.workflowId || `whatsapp-message-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const taskQueue = options?.taskQueue || process.env.WORKFLOW_TASK_QUEUE || 'default';

      console.log(`📱 Iniciando workflow de WhatsApp: ${workflowId}`);
      console.log(`📱 Mensaje de ${args.phoneNumber.substring(0, 5)}*** en conversación ${args.conversationId || 'nueva'}`);
      console.log(`🤖 Agente: ${args.agentId}`);
      console.log(`🏢 Site ID: ${args.siteId}`);
      console.log(`🔧 Using task queue: ${taskQueue}`);

      const handle = await client.workflow.start('answerWhatsappMessageWorkflow', {
        args: [args],
        taskQueue,
        workflowId,
      });

      console.log(`✅ Workflow de WhatsApp iniciado: ${handle.workflowId}, runId: ${handle.firstExecutionRunId}`);

      return {
        success: true,
        executionId: handle.firstExecutionRunId,
        workflowId: handle.workflowId,
        runId: handle.firstExecutionRunId,
        status: 'running'
      };

    } catch (error) {
      console.error('❌ Error al iniciar workflow de WhatsApp:', error);
      return {
        success: false,
        error: {
          code: 'WORKFLOW_EXECUTION_ERROR',
          message: error instanceof Error ? error.message : 'Error desconocido al iniciar workflow de WhatsApp'
        }
      };
    }
  }

  /**
   * Ejecuta el workflow para construir campañas
   */
  public async buildCampaigns(args: { site_id: string }, options?: WorkflowExecutionOptions): Promise<WorkflowExecutionResponse> {
    try {
      // Validar argumentos requeridos
      if (!args.site_id) {
        return {
          success: false,
          error: {
            code: 'INVALID_ARGUMENTS',
            message: 'Se requiere site_id para construir campañas'
          }
        };
      }

      const client = await this.initializeClient();
      
      const workflowId = options?.workflowId || `build-campaigns-${args.site_id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const taskQueue = options?.taskQueue || process.env.WORKFLOW_TASK_QUEUE || 'default';

      console.log(`🏗️ Iniciando workflow de construcción de campañas: ${workflowId}`);
      console.log(`🏢 Site ID: ${args.site_id}`);
      console.log(`🔧 Task queue: ${taskQueue}`);

      // Si es asíncrono, solo iniciar el workflow
      if (options?.async !== false) {
        const handle = await client.workflow.start('buildCampaignsWorkflow', {
          args: [args],
          taskQueue,
          workflowId,
        });

        console.log(`✅ Workflow de construcción de campañas iniciado: ${handle.workflowId}, runId: ${handle.firstExecutionRunId}`);

        return {
          success: true,
          executionId: handle.firstExecutionRunId,
          workflowId: handle.workflowId,
          runId: handle.firstExecutionRunId,
          status: 'running'
        };
      } else {
        // Ejecutar workflow y esperar resultado
        const result = await client.workflow.execute('buildCampaignsWorkflow', {
          args: [args],
          taskQueue,
          workflowId,
        });

        console.log(`✅ Workflow de construcción de campañas completado: ${workflowId}`);
        console.log(`📊 Resultado:`, result);

        return {
          success: true,
          workflowId,
          status: 'completed',
          data: result
        };
      }

    } catch (error) {
      console.error('❌ Error al ejecutar workflow de construcción de campañas:', error);
      return {
        success: false,
        error: {
          code: 'WORKFLOW_EXECUTION_ERROR',
          message: error instanceof Error ? error.message : 'Error desconocido al ejecutar workflow de construcción de campañas'
        }
      };
    }
  }

  /**
   * Ejecuta el workflow para construir contenido
   */
  public async buildContent(args: { site_id: string }, options?: WorkflowExecutionOptions): Promise<WorkflowExecutionResponse> {
    try {
      // Validar argumentos requeridos
      if (!args.site_id) {
        return {
          success: false,
          error: {
            code: 'INVALID_ARGUMENTS',
            message: 'Se requiere site_id para construir contenido'
          }
        };
      }

      const client = await this.initializeClient();
      
      const workflowId = options?.workflowId || `build-content-${args.site_id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const taskQueue = options?.taskQueue || process.env.WORKFLOW_TASK_QUEUE || 'default';

      console.log(`📝 Iniciando workflow de construcción de contenido: ${workflowId}`);
      console.log(`🏢 Site ID: ${args.site_id}`);
      console.log(`🔧 Task queue: ${taskQueue}`);

      // Si es asíncrono, solo iniciar el workflow
      if (options?.async !== false) {
        const handle = await client.workflow.start('buildContentWorkflow', {
          args: [args],
          taskQueue,
          workflowId,
        });

        console.log(`✅ Workflow de construcción de contenido iniciado: ${handle.workflowId}, runId: ${handle.firstExecutionRunId}`);

        return {
          success: true,
          executionId: handle.firstExecutionRunId,
          workflowId: handle.workflowId,
          runId: handle.firstExecutionRunId,
          status: 'running'
        };
      } else {
        // Ejecutar workflow y esperar resultado
        const result = await client.workflow.execute('buildContentWorkflow', {
          args: [args],
          taskQueue,
          workflowId,
        });

        console.log(`✅ Workflow de construcción de contenido completado: ${workflowId}`);
        console.log(`📊 Resultado:`, result);

        return {
          success: true,
          workflowId,
          status: 'completed',
          data: result
        };
      }

    } catch (error) {
      console.error('❌ Error al ejecutar workflow de construcción de contenido:', error);
      return {
        success: false,
        error: {
          code: 'WORKFLOW_EXECUTION_ERROR',
          message: error instanceof Error ? error.message : 'Error desconocido al ejecutar workflow de construcción de contenido'
        }
      };
    }
  }

  /**
   * Ejecuta el workflow para construir segmentos
   */
  public async buildSegments(args: { site_id: string }, options?: WorkflowExecutionOptions): Promise<WorkflowExecutionResponse> {
    try {
      // Validar argumentos requeridos
      if (!args.site_id) {
        return {
          success: false,
          error: {
            code: 'INVALID_ARGUMENTS',
            message: 'Se requiere site_id para construir segmentos'
          }
        };
      }

      const client = await this.initializeClient();
      
      const workflowId = options?.workflowId || `build-segments-${args.site_id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const taskQueue = options?.taskQueue || process.env.WORKFLOW_TASK_QUEUE || 'default';

      console.log(`👥 Iniciando workflow de construcción de segmentos: ${workflowId}`);
      console.log(`🏢 Site ID: ${args.site_id}`);
      console.log(`🔧 Task queue: ${taskQueue}`);

      // Si es asíncrono, solo iniciar el workflow
      if (options?.async !== false) {
        const handle = await client.workflow.start('buildSegmentsWorkflow', {
          args: [args],
          taskQueue,
          workflowId,
        });

        console.log(`✅ Workflow de construcción de segmentos iniciado: ${handle.workflowId}, runId: ${handle.firstExecutionRunId}`);

        return {
          success: true,
          executionId: handle.firstExecutionRunId,
          workflowId: handle.workflowId,
          runId: handle.firstExecutionRunId,
          status: 'running'
        };
      } else {
        // Ejecutar workflow y esperar resultado
        const result = await client.workflow.execute('buildSegmentsWorkflow', {
          args: [args],
          taskQueue,
          workflowId,
        });

        console.log(`✅ Workflow de construcción de segmentos completado: ${workflowId}`);
        console.log(`📊 Resultado:`, result);

        return {
          success: true,
          workflowId,
          status: 'completed',
          data: result
        };
      }

    } catch (error) {
      console.error('❌ Error al ejecutar workflow de construcción de segmentos:', error);
      return {
        success: false,
        error: {
          code: 'WORKFLOW_EXECUTION_ERROR',
          message: error instanceof Error ? error.message : 'Error desconocido al ejecutar workflow de construcción de segmentos'
        }
      };
    }
  }
}

export default WorkflowService;

// Exportar las interfaces para uso externo
export type { AnalysisData, ScheduleCustomerSupportParams, WhatsAppMessageWorkflowArgs, WorkflowExecutionResponse, WorkflowExecutionOptions }; 