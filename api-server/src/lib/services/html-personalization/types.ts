/**
 * Tipos y interfaces para el servicio de personalización HTML
 */

/**
 * Opciones de personalización
 */
export interface PersonalizationOptions {
  timeout?: number;
  userAgent?: string;
  personalization_level?: 'minimal' | 'moderate' | 'extensive';
  target_elements?: ('layout' | 'navigation' | 'content' | 'cta' | 'visuals' | 'forms' | 'all')[];
  implementation_method?: 'js_injection' | 'static_html' | 'hybrid';
  device_type?: 'all' | 'mobile' | 'desktop' | 'tablet';
  aiProvider?: 'openai' | 'anthropic' | 'gemini';
  aiModel?: string;
  include_preview?: boolean;
  include_diff?: boolean;
  include_performance_impact?: boolean;
  includeScreenshot?: boolean;
  test_mode?: boolean;
  user_id?: string;
  site_id?: string;
  target_pages?: string[];
  htmlContent?: string;
  screenshot?: string;
  originalAnalysis?: any;
  redis_ttl?: string;
  minified_code?: boolean;
}

/**
 * Modificación de personalización
 */
export interface PersonalizationModification {
  id: string;
  selector: string;
  operation_type: 'replace' | 'append' | 'remove' | 'rewrite';
  before_html?: string;
  after_html: string;
}

/**
 * Implementación de personalización
 */
export interface PersonalizationImplementation {
  type: 'javascript' | 'html' | 'hybrid';
  code: string;
}

/**
 * Respuesta de personalización
 */
export interface PersonalizationResponse {
  url: string;
  segment_id: string;
  personalization_id: string;
  personalizations: PersonalizationModification[];
  implementation_code: PersonalizationImplementation;
  preview_url?: string;
  screenshots?: {
    before?: string;
    after?: string;
  };
  metadata: {
    request: {
      timestamp: string;
      parameters: Record<string, any>;
    };
    analysis: {
      modelUsed: string;
      aiProvider: string;
      processingTime: string;
      segmentDataSource: string;
      siteScanDate: string;
      status: 'success' | 'partial' | 'failed';
      personalizationStrategy: string;
      storage?: {
        cached: boolean;
        cacheSuccess: boolean;
        timestamp: string;
      };
      minifiedCode: boolean;
    };
  };
  _requestMetadata?: {
    conversationId?: string;
    closed?: boolean;
    timestamp?: string;
    duration?: number;
    modelType?: string;
    modelId?: string;
  };
} 