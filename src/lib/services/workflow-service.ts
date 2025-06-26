import { BusinessWorkflowService } from './workflow/business-workflow-service';
import { DataWorkflowService } from './workflow/data-workflow-service';
import { BaseWorkflowService } from './workflow/base-workflow-service';
import type { 
  WorkflowExecutionOptions, 
  WorkflowExecutionResponse 
} from './workflow/base-workflow-service';
import type { 
  AnalysisData, 
  ScheduleCustomerSupportParams, 
  WhatsAppMessageWorkflowArgs, 
  EmailWorkflowArgs 
} from './workflow/business-workflow-service';

/**
 * WorkflowService refactorizado que combina funcionalidad de múltiples servicios especializados
 * Esta clase actúa como un facade pattern para acceder a todos los workflows disponibles
 */
export class WorkflowService extends BaseWorkflowService {
  private static instance: WorkflowService;
  private businessService: BusinessWorkflowService;
  private dataService: DataWorkflowService;

  private constructor() {
    super();
    this.businessService = BusinessWorkflowService.getInstance();
    this.dataService = DataWorkflowService.getInstance();
  }

  public static getInstance(): WorkflowService {
    if (!WorkflowService.instance) {
      WorkflowService.instance = new WorkflowService();
    }
    return WorkflowService.instance;
  }

  // Métodos delegados al BusinessWorkflowService
  public async sendEmailFromAgent(args: EmailWorkflowArgs, options?: WorkflowExecutionOptions): Promise<WorkflowExecutionResponse> {
    return this.businessService.sendEmailFromAgent(args, options);
  }

  public async scheduleCustomerSupport(params: ScheduleCustomerSupportParams, options?: WorkflowExecutionOptions): Promise<WorkflowExecutionResponse> {
    return this.businessService.scheduleCustomerSupport(params, options);
  }

  public async answerWhatsappMessage(args: WhatsAppMessageWorkflowArgs, options?: WorkflowExecutionOptions): Promise<WorkflowExecutionResponse> {
    return this.businessService.answerWhatsappMessage(args, options);
  }

  public async dailyStandUp(args: { site_id: string }, options?: WorkflowExecutionOptions): Promise<WorkflowExecutionResponse> {
    return this.businessService.dailyStandUp(args, options);
  }

  // Métodos delegados al DataWorkflowService
  public async buildCampaigns(args: { site_id: string }, options?: WorkflowExecutionOptions): Promise<WorkflowExecutionResponse> {
    return this.dataService.buildCampaigns(args, options);
  }

  public async buildContent(args: { site_id: string }, options?: WorkflowExecutionOptions): Promise<WorkflowExecutionResponse> {
    return this.dataService.buildContent(args, options);
  }

  public async buildSegments(args: { site_id: string }, options?: WorkflowExecutionOptions): Promise<WorkflowExecutionResponse> {
    return this.dataService.buildSegments(args, options);
  }

  public async buildSegmentsICP(args: { site_id: string }, options?: WorkflowExecutionOptions): Promise<WorkflowExecutionResponse> {
    return this.dataService.buildSegmentsICP(args, options);
  }

  public async leadFollowUp(args: { site_id: string; lead_id: string }, options?: WorkflowExecutionOptions): Promise<WorkflowExecutionResponse> {
    return this.dataService.leadFollowUp(args, options);
  }

  public async leadResearch(args: { site_id: string; lead_id: string }, options?: WorkflowExecutionOptions): Promise<WorkflowExecutionResponse> {
    return this.dataService.leadResearch(args, options);
  }

  // Métodos de configuración y reporte (heredados de BaseWorkflowService)
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
    const validation = this.validateTemporalConfiguration();
    
    const recommendations: string[] = [];
    
    if (config.deploymentType === 'local') {
      recommendations.push('Asegúrate de que el servidor Temporal local esté ejecutándose en localhost:7233');
    }
    
    if (config.deploymentType === 'cloud' && !this.getTemporalApiKey()) {
      recommendations.push('Configura TEMPORAL_CLOUD_API_KEY para usar Temporal Cloud');
    }
    
    if (validation.errors.length > 0) {
      recommendations.push('Corrige los errores de configuración antes de usar los workflows');
    }
    
    if (config.environment === 'development') {
      recommendations.push('Configuración en modo desarrollo - verifica que sea apropiada para tu entorno');
    }

    return {
      deploymentType: config.deploymentType,
      serverUrl: config.serverUrl,
      namespace: config.namespace,
      apiKeyConfigured: !!this.getTemporalApiKey(),
      environment: config.environment,
      forcedByEnvironment: config.forcedByEnvironment,
      environmentVariables: {
        TEMPORAL_ENV: process.env.TEMPORAL_ENV,
        TEMPORAL_SERVER_URL: process.env.TEMPORAL_SERVER_URL,
        TEMPORAL_NAMESPACE: process.env.TEMPORAL_NAMESPACE,
        TEMPORAL_CLOUD_API_KEY: process.env.TEMPORAL_CLOUD_API_KEY ? '[CONFIGURADA]' : undefined,
        NODE_ENV: process.env.NODE_ENV
      },
      validation,
      recommendations
    };
  }

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
    
    // Detectar entorno actual
    const nodeEnv = process.env.NODE_ENV;
    const currentServerUrl = process.env.TEMPORAL_SERVER_URL;
    const currentApiKey = process.env.TEMPORAL_CLOUD_API_KEY;
    
    if (nodeEnv === 'development' || nodeEnv === 'test') {
      reasoning.push('Entorno de desarrollo detectado');
      suggestedType = 'local';
      suggestedSettings.TEMPORAL_ENV = 'development';
      suggestedSettings.TEMPORAL_SERVER_URL = 'localhost:7233';
      suggestedSettings.TEMPORAL_NAMESPACE = 'default';
      reasoning.push('Configuración local recomendada para desarrollo');
    } else if (nodeEnv === 'production') {
      reasoning.push('Entorno de producción detectado');
      
      if (currentApiKey || currentServerUrl?.includes('temporal.cloud')) {
        suggestedType = 'cloud';
        suggestedSettings.TEMPORAL_SERVER_URL = currentServerUrl || 'namespace.account.tmprl.cloud:7233';
        suggestedSettings.TEMPORAL_NAMESPACE = 'namespace';
        suggestedSettings.TEMPORAL_CLOUD_API_KEY = '[TU_API_KEY]';
        reasoning.push('Temporal Cloud recomendado para producción');
      } else {
        suggestedType = 'custom';
        suggestedSettings.TEMPORAL_SERVER_URL = 'tu-servidor-temporal:7233';
        suggestedSettings.TEMPORAL_NAMESPACE = 'production';
        reasoning.push('Servidor Temporal personalizado para producción');
      }
    } else {
      reasoning.push('Entorno no especificado');
      suggestedType = 'local';
      suggestedSettings.TEMPORAL_ENV = 'development';
      suggestedSettings.TEMPORAL_SERVER_URL = 'localhost:7233';
      suggestedSettings.TEMPORAL_NAMESPACE = 'default';
      reasoning.push('Configuración local por defecto');
    }
    
    return {
      suggestedType,
      suggestedSettings,
      reasoning
    };
  }
}

export default WorkflowService;

// Exportar types para retrocompatibilidad
export type { 
  AnalysisData, 
  ScheduleCustomerSupportParams, 
  WhatsAppMessageWorkflowArgs, 
  WorkflowExecutionResponse, 
  WorkflowExecutionOptions,
  EmailWorkflowArgs
}; 