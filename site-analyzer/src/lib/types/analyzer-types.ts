// Interfaces para el analizador de sitios web

// Interface para la solicitud de análisis
export interface AnalyzeRequest {
  url: string;
  options?: {
    depth?: number;
    timeout?: number;
    userAgent?: string;
    includeScreenshot?: boolean;
    provider?: 'anthropic' | 'openai' | 'gemini';
    modelId?: string;
  };
  htmlContent?: string; // Contenido HTML renderizado de la página
  screenshot?: string; // Captura de pantalla en formato base64
}

// Interface para la información de bloques en el análisis estructurado
export interface BlockInfo {
  id: string;          // ID del bloque (si existe)
  type: string;        // Tipo de bloque (header, nav, main, section, footer, etc.)
  selector: string;    // Selector CSS para identificar el bloque
  classes: string[];   // Clases CSS aplicadas al bloque
  content_type: string; // Tipo de contenido (texto, imagen, formulario, etc.)
  relevance: {
    score: number;     // Puntuación de relevancia (0-100)
    reason: string;    // Razón por la que este bloque es relevante
  };
  children: number;    // Número de elementos hijos
  text_length: number; // Longitud del texto contenido (si aplica)
  location: {
    position: string;  // Posición en la página (top, middle, bottom)
    coordinates: {     // Coordenadas aproximadas (porcentaje del viewport)
      top: number;
      left: number;
    };
  };
  sub_blocks?: SubBlockInfo[]; // Información sobre sub-bloques importantes
}

// Interface para la información de sub-bloques
export interface SubBlockInfo {
  type: 'cta' | 'menu_item' | 'link' | 'form_field' | 'button' | 'icon' | 'interactive' | 'other';
  text: string;        // Texto del sub-bloque (si existe)
  selector: string;    // Selector CSS para identificar el sub-bloque
  action?: string;     // Acción que realiza (navegación, envío de formulario, etc.)
  relevance: number;   // Puntuación de relevancia (0-100)
  location: string;    // Ubicación relativa dentro del bloque padre
  attributes?: {       // Atributos relevantes
    href?: string;     // Para enlaces
    target?: string;   // Para enlaces (_blank, _self, etc.)
    id?: string;       // ID del elemento
    class?: string[];  // Clases del elemento
    [key: string]: any; // Otros atributos
  };
}

// Interface para la respuesta de análisis estructurado
export interface StructuredAnalysisResponse {
  site_info: {
    url: string;
    title: string;
    description: string;
    language: string;
  };
  blocks: BlockInfo[];
  hierarchy: {
    main_sections: string[];     // Array de los principales bloques funcionales
    navigation_structure: any[]; // Estructura de navegación
  };
  overview: {
    total_blocks: number;
    primary_content_blocks: number;
    navigation_blocks: number;
    interactive_elements: number;
  };
  metadata: {
    analyzed_by: string;
    timestamp: string;
    model_used: string;
    status: 'success' | 'error' | 'pending';
  };
}

// Interface para la respuesta de análisis
export interface AnalyzeResponse {
  summary: string;
  insights: string[];
  recommendations: Array<{
    issue: string;
    solution: string;
    priority: 'high' | 'medium' | 'low';
  }>;
  metadata: {
    analyzed_by: string;
    timestamp: string;
    model_used: string;
    status: 'success' | 'error' | 'pending';
  };
  rawHtml?: string;  // HTML capturado de la página
  screenshot?: string;  // Screenshot en formato base64
}

// Interface para el resultado de análisis estructurado
export interface StructuredAnalysisResult {
  structuredAnalysis: any;
  requestTime: number;
}

// Interface para errores de análisis estructurado
export interface StructuredAnalysisError {
  error: string;
  details: string;
  requestTime: number;
}

// Opciones para realizar análisis
export interface AnalysisOptions {
  depth?: number;
  timeout?: number;
  includeScreenshot?: boolean;
  userAgent?: string;
} 