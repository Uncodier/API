// Servicio para el análisis estructurado de sitios web
import { AnalyzeRequest, StructuredAnalysisResponse } from '../types/analyzer-types';
import { STRUCTURED_ANALYZER_SYSTEM_PROMPT } from '../config/analyzer-config';
import { prepareAnalysisData, callApiWithMessage, prepareApiMessage } from '../utils/api-utils';
import { captureScreenshot } from '../utils/image-utils';

/**
 * Genera un análisis estructurado básico para una URL
 */
function generateBasicStructuredAnalysis(url: string): StructuredAnalysisResponse {
  return {
    site_info: {
      url: url,
      title: 'Pendiente de análisis',
      description: 'Pendiente de análisis',
      language: 'es'
    },
    blocks: [],
    hierarchy: {
      main_sections: [],
      navigation_structure: []
    },
    overview: {
      total_blocks: 0,
      primary_content_blocks: 0,
      navigation_blocks: 0,
      interactive_elements: 0
    },
    metadata: {
      analyzed_by: 'Sistema',
      timestamp: new Date().toISOString(),
      model_used: 'none',
      status: 'pending'
    }
  };
}

/**
 * Realiza un análisis estructurado de un sitio web
 */
export async function structuredAnalyzerAgent(request: AnalyzeRequest): Promise<StructuredAnalysisResponse> {
  console.log(`[structuredAnalyzerAgent] Iniciando análisis estructurado para: ${request.url}`);
  
  try {
    // Preparar los datos para el análisis
    const { processedImage, htmlContent } = await prepareAnalysisData(request);
    
    // Crear el mensaje para la API
    const userMessage = `
    Analiza la estructura del siguiente sitio web y proporciona un análisis detallado en formato JSON:
    URL: ${request.url}
    
    ${htmlContent ? `HTML (estructura del sitio): 
\`\`\`html
${htmlContent}
\`\`\`
` : 'HTML no disponible'}
    
    IMPORTANTE: Este HTML ha sido capturado del DOM renderizado y preprocesado para mantener la estructura completa:
    
    1. El HTML representa el DOM final después de la ejecución de JavaScript, no el HTML inicial.
    2. Se han preservado todos los elementos estructurales, IDs, clases y URLs.
    3. Los textos largos han sido truncados con "..." para reducir el tamaño.
    4. Los SVGs han sido simplificados (atributos preservados pero contenido interno eliminado).
    5. Los elementos de navegación y CTAs han sido preservados completamente, incluyendo sus textos y URLs.
    6. Los scripts y estilos han sido eliminados.
    7. Se han expandido elementos colapsados como menús de navegación para capturar su estructura.
    
    ENFÓCATE EN BLOQUES ESTRUCTURALES, NO EN ELEMENTOS INDIVIDUALES:
    - Identifica las secciones principales como header, hero, características, testimonios, precios, footer
    - Agrupa elementos relacionados en bloques lógicos (ej. un "bloque de características" puede contener título, descripción, imagen y CTA)
    - Reconoce patrones comunes de diseño web (secciones hero, grids de características, testimonios, etc.)
    - Analiza la relación jerárquica entre bloques (relaciones padre-hijo)
    - Identifica el propósito y función de cada bloque principal
    - Busca elementos contenedores que agrupen contenido relacionado (div con clases como "section", "container", "block", etc.)
    - Presta atención a elementos HTML semánticos (header, nav, main, section, article, footer)
    - Identifica patrones estructurales repetidos que indiquen reutilización de componentes
    
    NO te enfoques en elementos individuales a menos que sean componentes independientes significativos. Por ejemplo:
    - SÍ incluye un menú de navegación como un bloque, NO cada elemento de menú individual
    - SÍ incluye una sección de características como un bloque, NO cada característica individual
    - SÍ incluye un carrusel de testimonios como un bloque, NO cada testimonio individual
    - SÍ incluye un footer como un bloque, NO cada enlace individual del footer
    
    SECCIONES OBLIGATORIAS QUE DEBES INCLUIR:
    1. "cta_elements" - Identifica TODOS los elementos de llamada a la acción (botones, enlaces prominentes, etc.)
    2. "navigation_elements" - Analiza TODOS los menús de navegación (principal, footer, móvil, etc.)
    3. "key_ux_patterns" - Identifica al menos 3-5 patrones UX clave del sitio
    4. "design_system_characteristics" - Documenta al menos 3-5 características del sistema de diseño
    
    Estas secciones son CRÍTICAS para el análisis y deben estar presentes incluso si son mínimas.
    
    Tu tarea es analizar esta estructura HTML y proporcionar un análisis detallado que incluya:
    1. Todos los BLOQUES PRINCIPALES del sitio (header, hero, características, testimonios, footer, etc.)
    2. La jerarquía y relación entre estos bloques
    3. Los componentes interactivos principales (formularios, carruseles, menús desplegables)
    4. La estructura de navegación completa
    5. Patrones de diseño y componentes reutilizados
    
    Responde con un objeto JSON que siga exactamente esta estructura:
    
    {
      "site_info": {
        "url": "URL del sitio",
        "title": "Título de la página",
        "description": "Descripción o propósito del sitio",
        "language": "Idioma principal del sitio"
      },
      "blocks": [
        {
          "id": "ID del bloque (si existe)",
          "type": "Tipo de bloque (header, hero, features, testimonials, pricing, footer, etc.)",
          "section_type": "Propósito funcional (navigation, content, cta, form, etc.)",
          "selector": "Selector CSS para identificar el bloque",
          "classes": ["Clases CSS aplicadas al bloque"],
          "content_type": "Tipo de contenido principal (text, image, video, mixed, etc.)",
          "description": "Descripción del propósito y contenido del bloque",
          "ux_role": "Rol UX del bloque (information, conversion, navigation, etc.)",
          "relevance": {
            "score": 85,
            "reason": "Razón por la que este bloque es relevante"
          },
          "children": 5,
          "text_length": 250,
          "location": {
            "position": "top/middle/bottom",
            "coordinates": {
              "top": 10,
              "left": 0
            }
          },
          "sub_blocks": [
            {
              "type": "Tipo de sub-bloque (heading, paragraph, image, cta, form, etc.)",
              "text": "Texto principal del sub-bloque",
              "function": "Función del sub-bloque (title, description, action, etc.)",
              "selector": "Selector CSS",
              "action": "Acción que realiza (si es interactivo)",
              "interactive": true/false,
              "prominence": "high/medium/low",
              "relevance": 90,
              "location": "Ubicación relativa dentro del bloque padre",
              "attributes": {
                "href": "URL destino (para enlaces)",
                "target": "_blank/_self (para enlaces)",
                "id": "ID del elemento",
                "class": ["Clases del elemento"]
              },
              "nested_elements": [
                {
                  "type": "Tipo de elemento anidado",
                  "role": "Rol del elemento anidado",
                  "interactive": true/false
                }
              ]
            }
          ]
        }
      ],
      "hierarchy": {
        "main_sections": ["Principales bloques funcionales"],
        "navigation_structure": [
          {
            "name": "Menú principal",
            "location": "header",
            "items": ["Inicio", "Productos", "Contacto"]
          }
        ],
        "user_flow": {
          "primary_path": ["Página inicial", "Catálogo", "Detalle de producto", "Carrito", "Checkout"]
        }
      },
      "ux_analysis": {
        "cta_elements": [
          {
            "text": "Comprar ahora",
            "type": "primary",
            "purpose": "purchase",
            "location": "hero",
            "prominence": "high",
            "design_pattern": "button",
            "urgency_factor": "none",
            "contrast_level": "high",
            "visual_style": "solid",
            "size": "large",
            "mobile_adaptation": "responsive",
            "effectiveness_score": 90,
            "selector": ".btn-primary"
          }
        ],
        "navigation_elements": [
          {
            "type": "main-menu",
            "location": "header",
            "style": "horizontal",
            "items": ["Inicio", "Productos", "Servicios", "Contacto"],
            "mobile_behavior": "collapses",
            "prominence": "high"
          }
        ],
        "forms": [
          {
            "purpose": "contact",
            "fields": ["name", "email", "message"],
            "location": "footer",
            "user_friction": "low",
            "validation_type": "on-submit"
          }
        ]
      },
      "overview": {
        "total_blocks": 15,
        "primary_content_blocks": 5,
        "navigation_blocks": 2,
        "interactive_elements": 8,
        "key_ux_patterns": [
          "Header con navegación horizontal y CTA prominente",
          "Hero con propuesta de valor clara y CTA contrastante",
          "Grid de características con iconos y descripciones breves"
        ],
        "design_system_characteristics": [
          "Uso consistente de bordes redondeados en elementos interactivos",
          "Paleta de colores limitada con azul como color primario",
          "Tipografía sans-serif para todo el contenido con variaciones de peso para jerarquía"
        ]
      },
      "metadata": {
        "analyzed_by": "Nombre del modelo",
        "timestamp": "Fecha y hora del análisis",
        "model_used": "Modelo utilizado",
        "status": "success/error/pending"
      }
    }
    
    RECUERDA: Enfócate en BLOQUES ESTRUCTURALES, no en elementos individuales. Cada elemento en el array "blocks" debe ser una sección o componente principal del sitio, no elementos HTML individuales.
    
    NO OLVIDES incluir las secciones obligatorias:
    - "cta_elements" con todos los elementos de llamada a la acción
    - "navigation_elements" con todos los menús de navegación
    - "key_ux_patterns" con patrones UX clave
    - "design_system_characteristics" con características del sistema de diseño
    
    Asegúrate de que el JSON sea válido y siga exactamente la estructura proporcionada.
    `;
    
    // Preparar el mensaje para la API
    const messages = prepareApiMessage(
      userMessage,
      processedImage,
      STRUCTURED_ANALYZER_SYSTEM_PROMPT,
      request.options?.provider
    );
    
    // Realizar la llamada a la API
    const response = await callApiWithMessage(
      messages,
      request.options?.provider as 'anthropic' | 'openai' | 'gemini' || 'anthropic',
      request.options?.modelId
    );
    
    // Procesar la respuesta
    const responseContent = response.choices[0]?.message?.content || '';
    console.log('[structuredAnalyzerAgent] Respuesta recibida del modelo:', responseContent.substring(0, 200) + '...');
    
    // Intentar parsear la respuesta como JSON
    try {
      // Extraer el JSON de la respuesta (puede estar rodeado de texto)
      const jsonMatch = responseContent.match(/```json\s*([\s\S]*?)\s*```|(\{[\s\S]*\})/);
      const jsonString = jsonMatch ? (jsonMatch[1] || jsonMatch[2]) : responseContent;
      
      console.log('[structuredAnalyzerAgent] Intentando parsear JSON:', jsonString.substring(0, 200) + '...');
      
      // Parsear el JSON
      let parsedResponse;
      try {
        parsedResponse = JSON.parse(jsonString);
      } catch (parseError) {
        console.error('[structuredAnalyzerAgent] Error al parsear JSON inicial:', parseError);
        
        // Intentar limpiar el JSON y volver a parsear
        const cleanedJsonString = jsonString
          .replace(/[\u0000-\u001F\u007F-\u009F]/g, '') // Eliminar caracteres de control
          .replace(/,\s*}/g, '}')                        // Eliminar comas finales en objetos
          .replace(/,\s*]/g, ']');                       // Eliminar comas finales en arrays
        
        console.log('[structuredAnalyzerAgent] Intentando parsear JSON limpio:', cleanedJsonString.substring(0, 200) + '...');
        parsedResponse = JSON.parse(cleanedJsonString);
      }
      
      console.log('[structuredAnalyzerAgent] JSON parseado correctamente. Claves:', Object.keys(parsedResponse));
      
      // Asegurarse de que la respuesta tiene la estructura esperada
      if (parsedResponse.site_info && Array.isArray(parsedResponse.blocks)) {
        console.log(`[structuredAnalyzerAgent] Estructura válida. Bloques encontrados: ${parsedResponse.blocks.length}`);
        
        // Añadir metadatos
        parsedResponse.metadata = {
          analyzed_by: `${request.options?.provider === 'openai' ? 'GPT' : 'Claude'} (Estructurado)`,
          timestamp: new Date().toISOString(),
          model_used: request.options?.modelId || (request.options?.provider === 'openai' ? 'gpt-4-vision-preview' : 'claude-3-opus-20240229'),
          status: 'success'
        };
        
        return parsedResponse;
      } else {
        console.error('[structuredAnalyzerAgent] La respuesta no tiene la estructura esperada:', 
          'site_info:', !!parsedResponse.site_info, 
          'blocks:', Array.isArray(parsedResponse.blocks) ? parsedResponse.blocks.length : 'no es array');
        
        // Intentar recuperar la estructura si es posible
        if (parsedResponse.structuredAnalysis && 
            parsedResponse.structuredAnalysis.site_info && 
            Array.isArray(parsedResponse.structuredAnalysis.blocks)) {
          console.log('[structuredAnalyzerAgent] Encontrada estructura anidada en structuredAnalysis');
          return {
            ...parsedResponse.structuredAnalysis,
            metadata: {
              analyzed_by: `${request.options?.provider === 'openai' ? 'GPT' : 'Claude'} (Estructurado)`,
              timestamp: new Date().toISOString(),
              model_used: request.options?.modelId || (request.options?.provider === 'openai' ? 'gpt-4-vision-preview' : 'claude-3-opus-20240229'),
              status: 'success'
            }
          };
        }
        
        // Devolver un análisis básico en caso de error
        const basicAnalysis = generateBasicStructuredAnalysis(request.url);
        basicAnalysis.metadata.status = 'error';
        basicAnalysis.metadata.analyzed_by = `${request.options?.provider === 'openai' ? 'GPT' : 'Claude'} (Error en estructurado)`;
        basicAnalysis.metadata.model_used = request.options?.modelId || (request.options?.provider === 'openai' ? 'gpt-4-vision-preview' : 'claude-3-opus-20240229');
        
        return basicAnalysis;
      }
    } catch (error) {
      console.error(`[structuredAnalyzerAgent] Error al procesar la respuesta JSON: ${error}`);
      throw new Error(`Error al procesar la respuesta JSON: ${error}`);
    }
  } catch (error) {
    console.error(`[structuredAnalyzerAgent] Error en el análisis estructurado: ${error}`);
    
    // Devolver un análisis básico en caso de error
    const basicAnalysis = generateBasicStructuredAnalysis(request.url);
    basicAnalysis.metadata.status = 'error';
    
    return basicAnalysis;
  }
}

/**
 * Realiza un análisis estructurado de un sitio web con opciones
 */
export async function performStructuredAnalysis(
  url: string, 
  options: { 
    depth?: number; 
    timeout?: number;
    includeScreenshot?: boolean;
    provider?: 'anthropic' | 'openai' | 'gemini';
    modelId?: string;
  } = {}
): Promise<StructuredAnalysisResponse> {
  console.log(`[performStructuredAnalysis] Iniciando análisis estructurado para ${url}`);
  
  // Construir el objeto de solicitud
  const analyzeRequest: AnalyzeRequest = {
    url,
    options: {
      ...options,
      // Asegurar que se utilice un modelo con suficiente capacidad para procesar HTML complejo
      provider: options.provider || 'anthropic',
      modelId: options.modelId || 'claude-3-opus-20240229'
    }
  };
  
  // Capturar screenshot solo si no está explícitamente desactivado
  if (options.includeScreenshot !== false) {
    console.log(`[performStructuredAnalysis] Capturando screenshot para ${url}...`);
    try {
      analyzeRequest.screenshot = await captureScreenshot(url, { timeout: options.timeout });
    } catch (error) {
      console.error(`[performStructuredAnalysis] Error al capturar screenshot: ${error}`);
    }
  } else {
    console.log(`[performStructuredAnalysis] Screenshot desactivado por el usuario para ${url}`);
  }
  
  // Realizar el análisis estructurado
  try {
    const result = await structuredAnalyzerAgent(analyzeRequest);
    
    // Verificar que el resultado tenga la estructura esperada
    if (!result.site_info || !Array.isArray(result.blocks)) {
      console.error('[performStructuredAnalysis] El resultado no tiene la estructura esperada');
      console.log('[performStructuredAnalysis] Estructura recibida:', Object.keys(result));
      
      // Intentar recuperar la estructura si está anidada
      if (result && 
          typeof result === 'object' && 
          'structuredAnalysis' in result && 
          result.structuredAnalysis && 
          typeof result.structuredAnalysis === 'object' &&
          'site_info' in result.structuredAnalysis && 
          'blocks' in result.structuredAnalysis && 
          Array.isArray(result.structuredAnalysis.blocks)) {
        console.log('[performStructuredAnalysis] Encontrada estructura anidada en structuredAnalysis');
        return result.structuredAnalysis as StructuredAnalysisResponse;
      }
      
      // Si no se puede recuperar, devolver un análisis básico
      return generateBasicStructuredAnalysis(url);
    }
    
    // Asegurarse de que blocks sea un array
    if (!Array.isArray(result.blocks)) {
      console.warn('[performStructuredAnalysis] blocks no es un array, corrigiendo...');
      result.blocks = [];
    }
    
    // Asegurarse de que hierarchy y overview existan
    if (!result.hierarchy) {
      console.warn('[performStructuredAnalysis] hierarchy no existe, inicializando...');
      result.hierarchy = {
        main_sections: [],
        navigation_structure: []
      };
    }
    
    if (!result.overview) {
      console.warn('[performStructuredAnalysis] overview no existe, inicializando...');
      result.overview = {
        total_blocks: result.blocks.length,
        primary_content_blocks: 0,
        navigation_blocks: 0,
        interactive_elements: 0
      };
    }
    
    // Asegurarse de que metadata exista
    if (!result.metadata) {
      console.warn('[performStructuredAnalysis] metadata no existe, inicializando...');
      result.metadata = {
        analyzed_by: `${options.provider === 'openai' ? 'GPT' : 'Claude'} (Estructurado)`,
        timestamp: new Date().toISOString(),
        model_used: options.modelId || (options.provider === 'openai' ? 'gpt-4-vision-preview' : 'claude-3-opus-20240229'),
        status: 'success'
      };
    }
    
    console.log(`[performStructuredAnalysis] Análisis completado con éxito. Bloques: ${result.blocks.length}`);
    return result;
  } catch (error) {
    console.error(`[performStructuredAnalysis] Error en el análisis estructurado: ${error}`);
    
    // Devolver un análisis básico en caso de error
    const basicAnalysis = generateBasicStructuredAnalysis(url);
    basicAnalysis.metadata.status = 'error';
    
    return basicAnalysis;
  }
}