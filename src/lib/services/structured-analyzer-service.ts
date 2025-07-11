// Servicio para el análisis estructurado de sitios web
import { AnalyzeRequest, StructuredAnalysisResponse } from '../types/analyzer-types';
import { STRUCTURED_ANALYZER_SYSTEM_PROMPT } from '../config/analyzer-config';
import { prepareAnalysisData, callApiWithMessage, prepareApiMessage } from '../utils/api-utils';
import { captureScreenshot } from '../utils/image-utils';
import { createBasicMessage } from '../utils/message-utils';
import fs from 'fs';
import path from 'path';

// Extend the AnalyzeRequest interface to include language
interface ExtendedAnalyzeRequest extends AnalyzeRequest {
  options?: {
    depth?: number;
    timeout?: number;
    userAgent?: string;
    includeScreenshot?: boolean;
    provider?: 'anthropic' | 'openai' | 'gemini';
    modelId?: string;
    language?: 'en' | 'es';
    htmlContent?: string;
    screenshot?: string;
  };
  deliverables?: {
    branding_analysis?: boolean;
    ux_assessment?: boolean;
    recommendations?: boolean;
    problems?: boolean;
    opportunities?: boolean;
    competitive_analysis?: boolean;
    accessibility_audit?: boolean;
    performance_metrics?: boolean;
  };
}

/**
 * Genera un análisis estructurado básico para una URL
 */
function generateBasicStructuredAnalysis(url: string): StructuredAnalysisResponse {
  return {
    site_info: {
      url: url,
      title: 'Pending analysis',
      description: 'Pending analysis',
      language: 'en'
    },
    blocks: [
      {
        id: 'header-block',
        type: 'header',
        section_type: 'navigation',
        selector: 'header#main-header, header.site-header[role="banner"], body > header:first-child',
        classes: [],
        content_type: 'mixed',
        description: 'Main header with navigation',
        business_objective: 'navigation',
        user_need: 'site navigation',
        ux_role: 'navigation',
        dynamic: false,
        relevance: {
          score: 90,
          reason: 'Primary navigation element'
        },
        children: 0,
        text_length: 0,
        location: {
          position: 'top',
          coordinates: {
            top: 0,
            left: 0
          }
        },
        content_list: ['Site navigation'],
        sub_blocks: [],
        content_blocks: [
          {
            description: 'Site navigation',
            selector: 'header > nav#header-nav, header nav.main-nav, header .navigation[role="navigation"]',
            dynamic: false
          }
        ]
      },
      {
        id: 'main-content',
        type: 'content',
        section_type: 'content',
        selector: 'main#main-content, main.site-content[role="main"], #primary.content-area',
        classes: [],
        content_type: 'text',
        description: 'Main content area',
        business_objective: 'information',
        user_need: 'access information',
        ux_role: 'information',
        dynamic: true,
        relevance: {
          score: 85,
          reason: 'Primary content area'
        },
        children: 0,
        text_length: 0,
        location: {
          position: 'middle',
          coordinates: {
            top: 100,
            left: 0
          }
        },
        content_list: ['Main content'],
        sub_blocks: [],
        content_blocks: [
          {
            description: 'Main content',
            selector: 'main#content, main.content-area, main[role="main"], #main-content',
            dynamic: true
          }
        ]
      },
      {
        id: 'footer-block',
        type: 'footer',
        section_type: 'navigation',
        selector: 'footer#site-footer, footer.site-footer[role="contentinfo"], body > footer:last-child',
        classes: [],
        content_type: 'mixed',
        description: 'Footer with additional links',
        business_objective: 'navigation',
        user_need: 'additional resources',
        ux_role: 'navigation',
        dynamic: false,
        relevance: {
          score: 70,
          reason: 'Secondary navigation element'
        },
        children: 0,
        text_length: 0,
        location: {
          position: 'bottom',
          coordinates: {
            top: 500,
            left: 0
          }
        },
        content_list: ['Footer links'],
        sub_blocks: [],
        content_blocks: [
          {
            description: 'Footer links',
            selector: 'footer .footer-links, footer nav.footer-nav, footer[role="contentinfo"] ul',
            dynamic: false
          }
        ]
      }
    ],
    hierarchy: {
      main_sections: ['header', 'content', 'footer'],
      navigation_structure: [
        {
          name: 'Main menu',
          location: 'header',
          items: []
        },
        {
          name: 'Footer menu',
          location: 'footer',
          items: []
        }
      ],
      user_flow: {
        primary_path: []
      }
    },
    ux_analysis: {
      cta_elements: [],
      navigation_elements: [
        {
          type: 'main-menu',
          location: 'header',
          style: 'horizontal',
          items: [],
          mobile_behavior: 'collapses',
          prominence: 'high'
        }
      ],
      forms: []
    },
    overview: {
      total_blocks: 3,
      primary_content_blocks: 1,
      navigation_blocks: 2,
      interactive_elements: 0,
      key_ux_patterns: [
        'Standard header-content-footer layout'
      ],
      design_system_characteristics: [
        'Not analyzed'
      ]
    },
    metadata: {
      analyzed_by: 'System',
      timestamp: new Date().toISOString(),
      model_used: 'none',
      status: 'pending'
    }
  };
}

/**
 * Solicita a otro agente que sanee un JSON malformado
 */
async function sanitizeJsonWithAgent(jsonString: string, provider: 'anthropic' | 'openai' | 'gemini' = 'anthropic', modelId?: string): Promise<string> {
  console.log('[sanitizeJsonWithAgent] Requesting JSON sanitization from another agent');
  
  // Crear un mensaje para solicitar la corrección del JSON
  const userMessage = `
  I need you to fix and sanitize the following malformed JSON:
  
  \`\`\`
  ${jsonString}
  \`\`\`
  
  Please fix any syntax errors, such as:
  - Missing or improperly closed quotes
  - Unclosed brackets or braces
  - Incorrect commas
  - Malformed escape characters
  - Comments that shouldn't be in a JSON
  
  Return ONLY the corrected JSON, without any explanations or additional comments.
  `;
  
  // Sistema prompt para el agente de saneamiento
  const systemPrompt = `You are an expert in JSON correction. Your task is to fix malformed JSONs and return them in a valid format.
  Do not include explanations, comments, or markdown in your response. Return ONLY the corrected JSON.`;
  
  // Preparar el mensaje para la API
  const messages = createBasicMessage(userMessage, systemPrompt);
  
  try {
    // Usar el mismo proveedor y modelo que se pasó como parámetro
    const response = await callApiWithMessage(
      messages,
      provider,
      modelId
    );
    
    // Extraer el contenido de la respuesta
    const responseContent = response.choices[0]?.message?.content || '';
    
    // Extraer el JSON de la respuesta (puede estar rodeado de texto)
    const jsonMatch = responseContent.match(/```(?:json)?\s*([\s\S]*?)\s*```|(\{[\s\S]*\})/);
    const sanitizedJsonString = jsonMatch ? (jsonMatch[1] || jsonMatch[2]) : responseContent;
    
    console.log('[sanitizeJsonWithAgent] Sanitized JSON received');
    
    return sanitizedJsonString;
  } catch (error) {
    console.error(`[sanitizeJsonWithAgent] Error sanitizing JSON: ${error}`);
    // Si falla, devolver el JSON original
    return jsonString;
  }
}

/**
 * Función mejorada para reparar JSON malformado
 */
function repairJsonString(jsonString: string): string {
  console.log(`[repairJsonString] Iniciando reparación de JSON`);
  
  let repairedJson = jsonString;
  
  // 1. Escapar caracteres especiales mal escapados
  repairedJson = repairedJson.replace(/\\/g, '\\\\'); // Escapar barras invertidas
  repairedJson = repairedJson.replace(/\\\\"/g, '\\"'); // Corregir comillas ya escapadas
  repairedJson = repairedJson.replace(/\\\\n/g, '\\n'); // Corregir saltos de línea ya escapados
  repairedJson = repairedJson.replace(/\\\\t/g, '\\t'); // Corregir tabs ya escapados
  repairedJson = repairedJson.replace(/\\\\r/g, '\\r'); // Corregir retornos de carro ya escapados
  
  // 2. Reparar comillas no escapadas dentro de strings
  repairedJson = repairedJson.replace(/:\s*"([^"]*)"([^",}\]]*)"([^"]*)"(\s*[,}\]])/g, (match, p1, p2, p3, p4) => {
    return `: "${p1}\\"${p2}\\"${p3}"${p4}`;
  });
  
  // 3. Reparar comas sobrantes antes de } o ]
  repairedJson = repairedJson.replace(/,(\s*[}\]])/g, '$1');
  
  // 4. Reparar arrays mal cerrados
  repairedJson = repairedJson.replace(/\[\s*([^,\]]+)\s*,\s*\]/g, '[$1]');
  
  // 5. Reparar objetos mal cerrados
  repairedJson = repairedJson.replace(/{\s*([^,}]+)\s*,\s*}/g, '{$1}');
  
  // 6. Asegurar que todos los strings estén entre comillas
  repairedJson = repairedJson.replace(/:\s*([^",{\[\]}\s][^,}\]]*[^",{\[\]}\s])(\s*[,}])/g, (match, value, ending) => {
    // Si no es un número, boolean o null, agregarlo entre comillas
    if (!/^(true|false|null|\d+\.?\d*|\[.*\]|\{.*\})$/.test(value.trim())) {
      return `: "${value.trim()}"${ending}`;
    }
    return match;
  });
  
  // 7. Reparar strings que terminan con caracteres especiales
  repairedJson = repairedJson.replace(/:\s*"([^"]*)"([^",}\]]*)"(\s*[,}\]])/g, ': "$1$2"$3');
  
  // 8. Limpiar espacios en blanco duplicados
  repairedJson = repairedJson.replace(/\s+/g, ' ');
  
  console.log(`[repairJsonString] Reparación completada`);
  return repairedJson;
}

/**
 * Función para crear un prompt simplificado que reduce errores de JSON
 */
function createSimplifiedPrompt(url: string, deliverables: any, language: string = 'es'): string {
  console.log(`[createSimplifiedPrompt] Creando prompt simplificado para ${url}`);
  
  const basePrompt = language === 'en' ? 
    `Analyze the website structure for: ${url}

Provide a structured analysis in JSON format. Keep the JSON simple and valid.

Required base structure:
{
  "site_info": {
    "url": "${url}",
    "title": "Site title",
    "description": "Brief description",
    "language": "en",
    "main_purpose": "Main purpose"
  },
  "blocks": [
    {
      "id": "unique-id",
      "type": "header|content|footer|sidebar|cta|form",
      "description": "Block description",
      "relevance": {"score": 85, "reason": "Relevance reason"}
    }
  ],
  "structure_analysis": {
    "overall_structure_score": 85,
    "strengths": ["Strength 1"],
    "weaknesses": ["Weakness 1"],
    "recommendations": [{"issue": "Issue", "recommendation": "Fix", "priority": "high"}]
  }
}` :
    `Analiza la estructura del sitio web: ${url}

Proporciona un análisis estructurado en formato JSON. Mantén el JSON simple y válido.

Estructura base requerida:
{
  "site_info": {
    "url": "${url}",
    "title": "Título del sitio",
    "description": "Descripción breve",
    "language": "es",
    "main_purpose": "Propósito principal"
  },
  "blocks": [
    {
      "id": "id-unico",
      "type": "header|content|footer|sidebar|cta|form",
      "description": "Descripción del bloque",
      "relevance": {"score": 85, "reason": "Razón de relevancia"}
    }
  ],
  "structure_analysis": {
    "overall_structure_score": 85,
    "strengths": ["Fortaleza 1"],
    "weaknesses": ["Debilidad 1"],
    "recommendations": [{"issue": "Problema", "recommendation": "Solución", "priority": "alta"}]
  }
}`;

  let additionalInstructions = '';
  
  // Agregar deliverables específicos de forma simplificada
  if (deliverables?.branding_analysis) {
    additionalInstructions += `\n\nAdd "branding_analysis" object with simplified structure:
{
  "branding_analysis": {
    "brand_archetype": "sage|hero|caregiver|explorer|creator",
    "primary_color": "#hexcolor",
    "secondary_color": "#hexcolor",
    "brand_voice": "Brand voice description",
    "communication_style": "friendly|professional|casual"
  }
}`;
  }
  
  if (deliverables?.ux_assessment) {
    additionalInstructions += `\n\nAdd "ux_assessment" object:
{
  "ux_assessment": {
    "overall_score": 85,
    "usability_score": 80,
    "accessibility_score": 75,
    "visual_design_score": 90
  }
}`;
  }
  
  if (deliverables?.recommendations) {
    additionalInstructions += `\n\nAdd "recommendations" array:
{
  "recommendations": [
    {
      "category": "UX",
      "priority": "alta",
      "title": "Recommendation title",
      "description": "Description"
    }
  ]
}`;
  }
  
  if (deliverables?.problems) {
    additionalInstructions += `\n\nAdd "problems" array:
{
  "problems": [
    {
      "category": "UX",
      "severity": "alto",
      "title": "Problem title",
      "description": "Description"
    }
  ]
}`;
  }
  
  if (deliverables?.opportunities) {
    additionalInstructions += `\n\nAdd "opportunities" array:
{
  "opportunities": [
    {
      "category": "UX",
      "potential": "alto",
      "title": "Opportunity title",
      "description": "Description"
    }
  ]
}`;
  }
  
  const finalPrompt = basePrompt + additionalInstructions + `\n\nIMPORTANT: 
- Return ONLY valid JSON without markdown formatting
- Use simple string values, avoid complex nested objects
- Escape special characters properly
- Keep descriptions concise`;
  
  console.log(`[createSimplifiedPrompt] Prompt simplificado creado, longitud: ${finalPrompt.length}`);
  return finalPrompt;
}

/**
 * Realiza un análisis estructurado de un sitio web
 */
export async function structuredAnalyzerAgent(request: ExtendedAnalyzeRequest): Promise<StructuredAnalysisResponse> {
  console.log(`[structuredAnalyzerAgent] Iniciando análisis estructurado para ${request.url}`);
  console.log(`[structuredAnalyzerAgent] Request deliverables recibidos:`, JSON.stringify(request.deliverables));
  
  try {
    // Preparar los datos para el análisis
    console.log(`[structuredAnalyzerAgent] Llamando a prepareAnalysisData...`);
    const { processedImage, htmlContent } = await prepareAnalysisData(request);
    console.log(`[structuredAnalyzerAgent] Datos preparados: imagen procesada: ${!!processedImage}, HTML obtenido: ${!!htmlContent}, longitud HTML: ${htmlContent?.length || 0}`);
    
    // Verificar si el HTML coincide con el de la solicitud
    if (request.htmlContent && htmlContent && request.htmlContent === htmlContent) {
      console.log(`[structuredAnalyzerAgent] El HTML recibido de prepareAnalysisData es idéntico al de la solicitud`);
    } else if (request.htmlContent && htmlContent) {
      console.log(`[structuredAnalyzerAgent] El HTML recibido de prepareAnalysisData (${htmlContent.length} bytes) es diferente al de la solicitud (${request.htmlContent.length} bytes)`);
    } else if (request.htmlContent && !htmlContent) {
      console.log(`[structuredAnalyzerAgent] ATENCIÓN: La solicitud tenía HTML (${request.htmlContent.length} bytes) pero prepareAnalysisData no devolvió HTML`);
    } else if (!request.htmlContent && htmlContent) {
      console.log(`[structuredAnalyzerAgent] La solicitud no tenía HTML, pero prepareAnalysisData obtuvo HTML (${htmlContent.length} bytes)`);
    } else {
      console.log(`[structuredAnalyzerAgent] Ni la solicitud ni prepareAnalysisData proporcionaron HTML`);
    }
    
    // Usar el prompt simplificado en lugar del complejo
    const language = request.options?.language || 'es';
    const userMessage = createSimplifiedPrompt(request.url, request.deliverables, language);
    
    console.log(`[structuredAnalyzerAgent] Usando prompt simplificado para ${request.url}`);
    console.log(`[structuredAnalyzerAgent] Longitud del prompt: ${userMessage.length} caracteres`);
    
    // Agregar HTML al mensaje si está disponible, pero de forma más controlada
    let enhancedUserMessage = userMessage;
    if (htmlContent && htmlContent.length > 0) {
      // Limitar el HTML a los primeros 10000 caracteres para evitar prompts demasiado largos
      const htmlLimit = 10000;
      const truncatedHtml = htmlContent.length > htmlLimit ? 
        htmlContent.substring(0, htmlLimit) + '...[HTML truncated]' : 
        htmlContent;
      
      console.log(`[structuredAnalyzerAgent] Agregando HTML truncado al mensaje (${truncatedHtml.length} bytes)`);
      enhancedUserMessage = `${userMessage}\n\nHTML content:\n${truncatedHtml}`;
    }
    
    console.log(`[structuredAnalyzerAgent] Mensaje final preparado, longitud: ${enhancedUserMessage.length} caracteres`);
    
         // Preparar el mensaje para la API
     const provider = request.options?.provider || 'openai';
     const modelId = request.options?.modelId || (provider === 'openai' ? 'gpt-4.1' : 'claude-3-sonnet-20240229');
     const systemPrompt = STRUCTURED_ANALYZER_SYSTEM_PROMPT;
     
     const apiMessage = prepareApiMessage(enhancedUserMessage, processedImage, systemPrompt, provider);
     console.log(`[structuredAnalyzerAgent] Mensaje preparado con ${apiMessage.length} elementos`);
     
     console.log(`[structuredAnalyzerAgent] Realizando llamada a la API...`);
     console.log(`[structuredAnalyzerAgent] Configuración: provider=${provider}, modelId=${modelId}`);
     
     // Realizar la llamada a la API
     const response = await callApiWithMessage(apiMessage, provider, modelId);
    
    if (!response || !response.choices || response.choices.length === 0) {
      console.error('[structuredAnalyzerAgent] No se recibió respuesta válida de la API');
      throw new Error('No se recibió respuesta válida de la API');
    }
    
    console.log(`[structuredAnalyzerAgent] Respuesta de la API recibida`);
    
    // Extraer el contenido de la respuesta
    const responseContent = response.choices[0]?.message?.content || '';
    
    if (typeof responseContent === 'string') {
      try {
        // Intentar extraer el JSON de la respuesta
        const jsonMatch = responseContent.match(/```json\s*([\s\S]*?)\s*```/) || 
                         responseContent.match(/```\s*([\s\S]*?)\s*```/) ||
                         responseContent.match(/\{[\s\S]*\}/) ||
                         [null, responseContent];
        
        let jsonContent = jsonMatch[1] || jsonMatch[0] || responseContent;
        jsonContent = jsonContent.trim();
        
        console.log(`[structuredAnalyzerAgent] JSON extraído, longitud: ${jsonContent.length} caracteres`);
        
        // Intentar parsear el JSON
        let structuredAnalysis: StructuredAnalysisResponse;
        
        try {
          structuredAnalysis = JSON.parse(jsonContent);
          console.log(`[structuredAnalyzerAgent] JSON parseado correctamente sin necesidad de correcciones`);
        } catch (jsonError) {
          console.error(`[structuredAnalyzerAgent] Error al parsear JSON: ${jsonError}`);
          console.log(`[structuredAnalyzerAgent] JSON problemático (primeros 500 caracteres):`, jsonContent.substring(0, 500));
          
          // Intentar reparar el JSON con la función mejorada
          console.log(`[structuredAnalyzerAgent] Intentando reparar JSON con función mejorada...`);
          const repairedJson = repairJsonString(jsonContent);
          
          try {
            structuredAnalysis = JSON.parse(repairedJson);
            console.log(`[structuredAnalyzerAgent] JSON reparado automáticamente y parseado correctamente`);
          } catch (repairError) {
            console.log(`[structuredAnalyzerAgent] Reparación automática falló, intentando sanitizar con agente...`);
            
            try {
              const sanitizedJson = await sanitizeJsonWithAgent(jsonContent, request.options?.provider, request.options?.modelId);
              structuredAnalysis = JSON.parse(sanitizedJson);
              console.log(`[structuredAnalyzerAgent] JSON sanitizado y parseado correctamente`);
            } catch (sanitizeError) {
              console.error(`[structuredAnalyzerAgent] Error al sanitizar JSON: ${sanitizeError}`);
              
              // Último intento: crear un objeto básico con la información que podamos extraer
              console.log(`[structuredAnalyzerAgent] Creando estructura básica de fallback...`);
              
              structuredAnalysis = {
                site_info: {
                  url: request.url,
                  title: 'Error procesando análisis',
                  description: 'Ocurrió un error al procesar el análisis estructurado',
                  language: 'es',
                  main_purpose: 'Error en análisis'
                },
                blocks: [],
                structure_analysis: {
                  hierarchy_score: 0,
                  clarity_score: 0,
                  consistency_score: 0,
                  navigation_score: 0,
                  overall_structure_score: 0,
                  strengths: [],
                  weaknesses: ['Error en el análisis estructurado'],
                  recommendations: [{
                    issue: 'Error de procesamiento',
                    recommendation: 'Reintentar el análisis con un prompt más simple',
                    impact: 'Análisis incompleto',
                    priority: 'alta'
                  }]
                },
                hierarchy: {
                  main_sections: [],
                  navigation_structure: [],
                  user_flow: {
                    primary_path: []
                  }
                },
                ux_analysis: {
                  cta_elements: [],
                  navigation_elements: [],
                  forms: []
                },
                overview: {
                  total_blocks: 0,
                  primary_content_blocks: 0,
                  navigation_blocks: 0,
                  interactive_elements: 0,
                  key_ux_patterns: [],
                  design_system_characteristics: []
                },
                metadata: {
                  analyzed_by: request.options?.provider || 'unknown',
                  timestamp: new Date().toISOString(),
                  model_used: request.options?.modelId || 'unknown',
                  status: 'error' as const
                }
              };
              
              console.log(`[structuredAnalyzerAgent] Estructura básica de fallback creada`);
            }
          }
        }
        
        // Validaciones mínimas esenciales (solo si faltan campos críticos)
        if (!structuredAnalysis.site_info) {
          console.warn('[structuredAnalyzerAgent] Agregando site_info faltante');
          structuredAnalysis.site_info = {
            url: request.url,
            title: 'No title provided',
            description: 'No description provided',
            language: 'en'
          };
        }
        
        if (!structuredAnalysis.blocks || !Array.isArray(structuredAnalysis.blocks)) {
          console.warn('[structuredAnalyzerAgent] Agregando estructura de blocks faltante');
          structuredAnalysis.blocks = [];
        }
        
        if (!structuredAnalysis.structure_analysis) {
          console.warn('[structuredAnalyzerAgent] Agregando structure_analysis faltante');
          structuredAnalysis.structure_analysis = {
            hierarchy_score: 50,
            clarity_score: 50,
            consistency_score: 50,
            navigation_score: 50,
            overall_structure_score: 50,
            strengths: [],
            weaknesses: [],
            recommendations: []
          };
        }
        
        // Solo normalizar IDs si hay duplicados reales
        const usedIds = new Set<string>();
        let hasDuplicates = false;
        
        structuredAnalysis.blocks.forEach(block => {
          if (block.id && usedIds.has(block.id)) {
            hasDuplicates = true;
          } else if (block.id) {
            usedIds.add(block.id);
          }
        });
        
        if (hasDuplicates) {
          console.log('[structuredAnalyzerAgent] Corrigiendo IDs duplicados en blocks');
          const newUsedIds = new Set<string>();
          structuredAnalysis.blocks = structuredAnalysis.blocks.map((block, index) => {
            if (!block.id || newUsedIds.has(block.id)) {
              block.id = `block-${index + 1}`;
            }
            newUsedIds.add(block.id);
            return block;
          });
        }
        
        // NO normalizar prioridades - mantener el formato original del modelo
        // (Comentado para evitar cambios innecesarios)
        /*
        if (structuredAnalysis.structure_analysis?.recommendations) {
          structuredAnalysis.structure_analysis.recommendations = 
            structuredAnalysis.structure_analysis.recommendations.map((rec: { 
              issue: string; 
              recommendation: string; 
              impact: string; 
              priority: string;
            }) => {
              // Normalizar prioridad
              if (rec.priority) {
                const priority = rec.priority.toLowerCase();
                if (priority === 'alta' || priority === 'high') {
                  rec.priority = 'high';
                } else if (priority === 'baja' || priority === 'low') {
                  rec.priority = 'low';
                } else {
                  rec.priority = 'medium';
                }
              } else {
                rec.priority = 'medium';
              }
              return rec;
            });
        }
        */
        
        console.log(`[structuredAnalyzerAgent] Análisis estructurado completado con éxito`);
        return structuredAnalysis;
      } catch (error) {
        console.error(`[structuredAnalyzerAgent] Error al procesar la respuesta: ${error}`);
        throw error;
      }
    } else {
      throw new Error('La respuesta de la API no tiene el formato esperado');
    }
  } catch (promptError) {
    console.error(`[structuredAnalyzerAgent] Error al cargar el prompt: ${promptError}`);
    throw promptError;
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
    language?: 'en' | 'es';
    htmlContent?: string;
    screenshot?: string;
    deliverables?: {
      branding_analysis?: boolean;
      ux_assessment?: boolean;
      recommendations?: boolean;
      problems?: boolean;
      opportunities?: boolean;
      competitive_analysis?: boolean;
      accessibility_audit?: boolean;
      performance_metrics?: boolean;
    };
  } = {}
): Promise<StructuredAnalysisResponse> {
  // Log incoming options
  console.log(`[performStructuredAnalysis] Starting analysis for ${url} with options:`, JSON.stringify({
    depth: options.depth,
    timeout: options.timeout,
    includeScreenshot: options.includeScreenshot,
    provider: options.provider,
    modelId: options.modelId,
    htmlContentPresent: options.htmlContent ? `Yes (${options.htmlContent.length} bytes)` : 'No',
    screenshotPresent: options.screenshot ? 'Yes' : 'No',
    deliverables: options.deliverables
  }));
  
  // Log all option keys to see if htmlContent is actually present as a property
  const optionKeys = Object.keys(options);
  console.log(`[performStructuredAnalysis] Option keys available: ${JSON.stringify(optionKeys)}`);
  
  // Check if htmlContent can be accessed as expected
  if (optionKeys.includes('htmlContent')) {
    const htmlContentValue = (options as any)['htmlContent'];
    const htmlContentTypeOf = typeof htmlContentValue;
    const htmlContentLength = htmlContentValue ? htmlContentValue.length : 0;
    console.log(`[performStructuredAnalysis] htmlContent property found: type=${htmlContentTypeOf}, length=${htmlContentLength}`);
    
    // Log a sample of the HTML content
    if (htmlContentValue && htmlContentLength > 0) {
      console.log(`[performStructuredAnalysis] Sample of htmlContent: ${htmlContentValue.substring(0, 100).replace(/\n/g, '\\n')}...`);
    }
  } else {
    console.log(`[performStructuredAnalysis] htmlContent property NOT found in options object!`);
  }
  
  // Construir el objeto de solicitud
  const analyzeRequest: ExtendedAnalyzeRequest = {
    url,
    options,
    // Include htmlContent if provided in options
    htmlContent: options.htmlContent,
    // Include screenshot if provided in options
    screenshot: options.screenshot,
    // Include deliverables if provided in options
    deliverables: options.deliverables
  };
  
  // Log the constructed request
  console.log(`[performStructuredAnalysis] Created analyzeRequest object:`, JSON.stringify({
    url: analyzeRequest.url,
    htmlContentPresent: analyzeRequest.htmlContent ? `Yes (${analyzeRequest.htmlContent.length} bytes)` : 'No',
    screenshotPresent: analyzeRequest.screenshot ? 'Yes' : 'No',
    optionsPresent: analyzeRequest.options ? 'Yes' : 'No'
  }));
  
  // Capturar screenshot solo si no está explícitamente desactivado y no se proporcionó uno
  if (options.includeScreenshot !== false && !analyzeRequest.screenshot) {
    console.log(`[performStructuredAnalysis] Capturando screenshot para ${url}...`);
    try {
      analyzeRequest.screenshot = await captureScreenshot(url, { timeout: options.timeout });
      console.log(`[performStructuredAnalysis] Screenshot capturado exitosamente: ${analyzeRequest.screenshot ? 'Yes' : 'No'}`);
    } catch (error) {
      console.error(`[performStructuredAnalysis] Error al capturar screenshot: ${error}`);
    }
  } else if (analyzeRequest.screenshot) {
    console.log(`[performStructuredAnalysis] Usando screenshot proporcionado para ${url}`);
  } else {
    console.log(`[performStructuredAnalysis] Screenshot desactivado por el usuario para ${url}`);
  }
  
  // Realizar el análisis estructurado
  console.log(`[performStructuredAnalysis] Pasando a structuredAnalyzerAgent with request:`, JSON.stringify({
    url: analyzeRequest.url,
    htmlContentPresent: analyzeRequest.htmlContent ? `Yes (${analyzeRequest.htmlContent.length} bytes)` : 'No',
    screenshotPresent: analyzeRequest.screenshot ? 'Yes' : 'No',
    optionsPresent: analyzeRequest.options ? 'Yes' : 'No',
    deliverablesPresent: analyzeRequest.deliverables ? 'Yes' : 'No',
    deliverables: analyzeRequest.deliverables
  }));
  
  return structuredAnalyzerAgent(analyzeRequest);
}