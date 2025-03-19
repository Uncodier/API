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
  section_type?: string; // Propósito funcional (navigation, content, cta, form, etc.)
  selector: string;    // Selector CSS para identificar el bloque
  classes: string[];   // Clases CSS aplicadas al bloque
  content_type: string; // Tipo de contenido (texto, imagen, formulario, etc.)
  description?: string; // Descripción del propósito y contenido del bloque
  business_objective?: string; // Objetivo de negocio que cumple este bloque
  user_need?: string;  // Necesidad del usuario que satisface este bloque
  ux_role?: string;    // Rol UX del bloque (information, conversion, navigation, etc.)
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
  content_list?: string[]; // Lista de contenido textual relevante del bloque
  sub_blocks?: SubBlockInfo[]; // Información sobre sub-bloques importantes
  subBlocks?: SubBlockInfo[]; // Alias para compatibilidad
}

// Interface para la información de sub-bloques
export interface SubBlockInfo {
  type: 'cta' | 'menu_item' | 'link' | 'form_field' | 'button' | 'icon' | 'interactive' | 'heading' | 'paragraph' | 'image' | 'video' | 'other';
  text: string;        // Texto del sub-bloque (si existe)
  selector: string;    // Selector CSS para identificar el sub-bloque
  function?: string;   // Función específica del sub-bloque (title, description, action, etc.)
  purpose?: string;    // Propósito desde la perspectiva del usuario (informar, guiar, convertir, etc.)
  action?: string;     // Acción que realiza (navegación, envío de formulario, etc.)
  interactive?: boolean; // Si el elemento es interactivo
  prominence?: 'high' | 'medium' | 'low'; // Prominencia visual del elemento
  relevance: number;   // Puntuación de relevancia (0-100)
  location: string;    // Ubicación relativa dentro del bloque padre
  attributes?: {       // Atributos relevantes
    href?: string;     // Para enlaces
    target?: string;   // Para enlaces (_blank, _self, etc.)
    id?: string;       // ID del elemento
    class?: string[];  // Clases del elemento
    [key: string]: any; // Otros atributos
  };
  nested_elements?: Array<{
    type: string;
    role: string;
    interactive: boolean;
    purpose?: string;  // Propósito específico de este elemento anidado
  }>;
}

// Interface para la respuesta de análisis estructurado
export interface StructuredAnalysisResponse {
  site_info: {
    url: string;
    title: string;
    description: string;
    language: string;
    main_purpose?: string;
  };
  blocks: BlockInfo[];
  hierarchy?: {
    main_sections: string[];     // Array de los principales bloques funcionales
    navigation_structure: any[]; // Estructura de navegación
    user_flow?: {
      primary_path: string[];    // Descripción del recorrido principal del usuario
    };
  };
  ux_analysis?: {
    cta_elements?: Array<any>;   // Elementos de llamada a la acción
    navigation_elements?: Array<any>; // Elementos de navegación
    forms?: Array<any>;          // Formularios
  };
  overview?: {
    total_blocks: number;
    primary_content_blocks: number;
    navigation_blocks: number;
    interactive_elements: number;
    key_ux_patterns?: string[];  // Patrones UX clave identificados
    design_system_characteristics?: string[]; // Características del sistema de diseño
  };
  structure_analysis?: {
    hierarchy_score: number;
    clarity_score: number;
    consistency_score: number;
    navigation_score: number;
    overall_structure_score: number;
    strengths: string[];
    weaknesses: string[];
    recommendations: Array<{
      issue: string;
      recommendation: string;
      impact: string;
      priority: string;
    }>;
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