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
    
    // Determinar qué prompt usar basado en el idioma preferido (si está disponible)
    let promptTemplate;
    const promptPath = path.join(process.cwd(), 'src', 'app', 'api', 'site', 'analyze', 'structured-prompt.txt');
    const promptEnPath = path.join(process.cwd(), 'src', 'app', 'api', 'site', 'analyze', 'structured-prompt-en.txt');
    
    try {
      // Intentar cargar el prompt en el idioma preferido o el predeterminado
      if (request.options?.language === 'en' && fs.existsSync(promptEnPath)) {
        promptTemplate = fs.readFileSync(promptEnPath, 'utf8');
      } else if (fs.existsSync(promptPath)) {
        promptTemplate = fs.readFileSync(promptPath, 'utf8');
      } else {
        // Fallback al prompt hardcodeado si no se pueden cargar los archivos
        promptTemplate = `
        Analiza la estructura del siguiente sitio web:
        URL: {url}
        
        Proporciona un análisis estructurado detallado del sitio web, identificando los bloques principales, su jerarquía, y su propósito. Devuelve tu análisis en formato JSON con la siguiente estructura BASE:
        
        \`\`\`json
        {
          "site_info": {
            "url": "URL del sitio",
            "title": "Título del sitio",
            "description": "Descripción breve del sitio",
            "language": "Idioma principal del sitio (código ISO)",
            "main_purpose": "Propósito principal del sitio"
          },
          "blocks": [
            {
              "id": "identificador-único-del-bloque",
              "type": "header|content|footer|sidebar|cta|form|gallery|testimonial|etc",
              "section_type": "navigation|content|form|media|etc",
              "selector": "Selector CSS preciso y único (preferentemente con ID) que identifica exactamente este bloque. Incluye múltiples atributos para asegurar unicidad.",
              "classes": ["clase1", "clase2"],
              "content_type": "text|image|video|mixed",
              "description": "Descripción del bloque y su función",
              "business_objective": "Objetivo de negocio que cumple este bloque",
              "user_need": "Necesidad del usuario que satisface",
              "ux_role": "Rol en la experiencia de usuario",
              "dynamic": true|false,
              "relevance": {
                "score": 0-100,
                "reason": "Razón de la puntuación de relevancia"
              },
              "children": 0,
              "text_length": 0,
              "location": {
                "position": "top|middle|bottom|left|right",
                "coordinates": {
                  "top": 0,
                  "left": 0
                }
              },
              "content_list": ["Elemento 1", "Elemento 2"],
              "sub_blocks": [],
              "content_blocks": [
                {
                  "description": "Texto o descripción del contenido del elemento",
                  "selector": "Selector CSS preciso y único (preferentemente con ID) que identifica exactamente este elemento de contenido. Incluye múltiples atributos para asegurar unicidad.",
                  "dynamic": true|false
                },
                {
                  "description": "URL o texto del enlace",
                  "selector": "#elemento-identificador, .clase[atributo='valor']:nth-child(n)",
                  "dynamic": false
                }
              ]
            }
          ],
          "structure_analysis": {
            "hierarchy_score": 0-100,
            "clarity_score": 0-100,
            "consistency_score": 0-100,
            "navigation_score": 0-100,
            "overall_structure_score": 0-100,
            "strengths": [
              "Fortaleza 1 de la estructura",
              "Fortaleza 2 de la estructura"
            ],
            "weaknesses": [
              "Debilidad 1 de la estructura",
              "Debilidad 2 de la estructura"
            ],
            "recommendations": [
              {
                "issue": "Problema identificado",
                "recommendation": "Recomendación para mejorar",
                "impact": "Impacto esperado",
                "priority": "alta|media|baja"
              }
            ]
          }
        }
        \`\`\`
        
        IMPORTANTE: 
        - Asegúrate de que tu respuesta sea un JSON válido que incluya la estructura BASE mostrada arriba
        - Identifica al menos 5-7 bloques principales del sitio y proporciona un análisis detallado de la estructura general
        - Si se solicitan deliverables específicos adicionales, AGRÉGALOS al JSON base como objetos adicionales
        - Puedes incluir objetos adicionales en el JSON raíz según las instrucciones específicas que se proporcionen
        `;
      }
      
      // Reemplazar placeholders en el prompt
      const userMessage = promptTemplate.replace('{url}', request.url);
      console.log(`[structuredAnalyzerAgent] Prompt base preparado para ${request.url}`);
      
      // Modificación: Agregar HTML al mensaje de usuario si está disponible
      let enhancedUserMessage = userMessage;
      if (htmlContent) {
        console.log(`[structuredAnalyzerAgent] Agregando HTML al mensaje para el análisis (${htmlContent.length} bytes)`);
        console.log(`[structuredAnalyzerAgent] Primeros 100 caracteres del HTML: ${htmlContent.substring(0, 100).replace(/\n/g, '\\n')}...`);
        // Agregar el HTML preprocesado al mensaje
        enhancedUserMessage = `${userMessage}\n\nAquí está el HTML del sitio para tu análisis:\n\n${htmlContent}`;
        console.log(`[structuredAnalyzerAgent] Mensaje mejorado con HTML (longitud total: ${enhancedUserMessage.length} bytes)`);
      } else {
        console.log(`[structuredAnalyzerAgent] No hay HTML disponible para incluir en el análisis`);
        console.log(`[structuredAnalyzerAgent] Contenido de request.htmlContent: ${request.htmlContent ? request.htmlContent.substring(0, 100) + '...' : 'undefined'}`);
      }
      
      // Agregar información sobre deliverables específicos al prompt
      if (request.deliverables) {
        console.log(`[structuredAnalyzerAgent] Agregando deliverables específicos al prompt`);
        console.log(`[structuredAnalyzerAgent] Deliverables a procesar:`, JSON.stringify(request.deliverables));
        let deliverablesInstructions = '\n\n=== DELIVERABLES ESPECÍFICOS SOLICITADOS ===\n';
        deliverablesInstructions += 'IMPORTANTE: Incluye en tu respuesta JSON los siguientes objetos ÚNICAMENTE si se solicitan:\n';
        
        if (request.deliverables.branding_analysis) {
          console.log(`[structuredAnalyzerAgent] ✅ Agregando instrucciones para branding_analysis`);
          deliverablesInstructions += `
✅ BRANDING ANALYSIS: Agrega un objeto "branding_analysis" con esta estructura exacta:
{
  "branding_analysis": {
    "brand_pyramid": {
      "brand_essence": "Esencia fundamental de la marca extraída del contenido",
      "brand_personality": "Personalidad de marca inferida del tono y estilo",
      "brand_benefits": "Beneficios clave que ofrece la marca",
      "brand_attributes": "Atributos distintivos de la marca",
      "brand_values": "Valores que transmite la marca",
      "brand_promise": "Promesa de valor principal"
    },
    "brand_archetype": "Arquetipo de marca (ej: El Sabio, El Héroe, El Cuidador, etc.)",
    "color_palette": {
      "primary_color": "#código_hex_color_primario",
      "secondary_color": "#código_hex_color_secundario", 
      "accent_color": "#código_hex_color_acento",
      "neutral_colors": ["#color1", "#color2", "#color3"]
    },
    "typography": {
      "primary_font": "Fuente principal detectada",
      "secondary_font": "Fuente secundaria detectada",
      "font_hierarchy": "Descripción de la jerarquía tipográfica",
      "font_sizes": "Escala de tamaños utilizada"
    },
    "voice_and_tone": {
      "brand_voice": "Voz de marca identificada",
      "communication_style": "Estilo de comunicación",
      "personality_traits": ["rasgo1", "rasgo2", "rasgo3"],
      "do_and_dont": {
        "do": ["Lo que SÍ debe hacer la marca", "Práctica recomendada"],
        "dont": ["Lo que NO debe hacer la marca", "Práctica a evitar"]
      }
    },
    "brand_guidelines": {
      "logo_usage": "Guías de uso del logo",
      "color_usage": "Guías de uso de colores",
      "typography_usage": "Guías de uso tipográfico",
      "imagery_style": "Estilo de imágenes",
      "messaging_guidelines": "Guías de mensajería"
    },
    "brand_assets": {
      "logo_variations": ["URL_o_descripción_logo"],
      "color_swatches": ["#color1", "#color2"],
      "font_files": ["fuente1", "fuente2"],
      "templates": ["plantilla1", "plantilla2"]
    }
  }
}
`;
        } else {
          console.log(`[structuredAnalyzerAgent] ❌ branding_analysis = false, no se agregará al prompt`);
        }
        
        if (request.deliverables.ux_assessment) {
          console.log(`[structuredAnalyzerAgent] ✅ Agregando instrucciones para ux_assessment`);
          deliverablesInstructions += `
✅ UX ASSESSMENT: Agrega un objeto "ux_assessment" con scores del 1-100:
{
  "ux_assessment": {
    "overall_score": 85,
    "usability_score": 80,
    "accessibility_score": 75,
    "visual_design_score": 90,
    "performance_score": 70,
    "branding_consistency_score": 85,
    "user_experience_details": {
      "navigation_clarity": 80,
      "content_organization": 85,
      "visual_hierarchy": 90,
      "responsive_design": 75,
      "load_time": 70,
      "error_handling": 60
    }
  }
}
`;
        } else {
          console.log(`[structuredAnalyzerAgent] ❌ ux_assessment = false, no se agregará al prompt`);
        }
        
        if (request.deliverables.recommendations) {
          console.log(`[structuredAnalyzerAgent] ✅ Agregando instrucciones para recommendations`);
          deliverablesInstructions += `
✅ RECOMMENDATIONS: Agrega un array "recommendations":
{
  "recommendations": [
    {
      "category": "UX|Branding|Performance|Accessibility",
      "priority": "alta|media|baja",
      "effort": "alto|medio|bajo",
      "title": "Título de la recomendación",
      "description": "Descripción detallada",
      "impact": "Impacto esperado",
      "implementation_steps": ["Paso 1", "Paso 2", "Paso 3"]
    }
  ]
}
`;
        } else {
          console.log(`[structuredAnalyzerAgent] ❌ recommendations = false, no se agregará al prompt`);
        }
        
        if (request.deliverables.problems) {
          console.log(`[structuredAnalyzerAgent] ✅ Agregando instrucciones para problems`);
          deliverablesInstructions += `
✅ PROBLEMS: Agrega un array "problems":
{
  "problems": [
    {
      "category": "UX|Branding|Performance|Accessibility",
      "severity": "crítico|alto|medio|bajo",
      "title": "Título del problema",
      "description": "Descripción del problema",
      "user_impact": "Impacto en el usuario",
      "business_impact": "Impacto en el negocio",
      "suggested_solutions": ["Solución 1", "Solución 2"]
    }
  ]
}
`;
        } else {
          console.log(`[structuredAnalyzerAgent] ❌ problems = false, no se agregará al prompt`);
        }
        
        if (request.deliverables.opportunities) {
          console.log(`[structuredAnalyzerAgent] ✅ Agregando instrucciones para opportunities`);
          deliverablesInstructions += `
✅ OPPORTUNITIES: Agrega un array "opportunities":
{
  "opportunities": [
    {
      "category": "UX|Branding|Performance|Growth",
      "potential": "alto|medio|bajo",
      "complexity": "alta|media|baja",
      "title": "Título de la oportunidad",
      "description": "Descripción de la oportunidad",
      "expected_outcomes": ["Resultado 1", "Resultado 2"],
      "implementation_timeline": "2-3 semanas|1-2 meses|3-6 meses"
    }
  ]
}
`;
        } else {
          console.log(`[structuredAnalyzerAgent] ❌ opportunities = false, no se agregará al prompt`);
        }
        
        deliverablesInstructions += '\n⚠️ SOLO incluye en tu JSON los deliverables marcados con ✅ arriba.\n';
        deliverablesInstructions += '⚠️ Si no se solicita un deliverable específico, NO lo incluyas en la respuesta.\n';
        deliverablesInstructions += '\n📋 EJEMPLO DE JSON FINAL CON DELIVERABLES:\n';
        deliverablesInstructions += 'Si se solicita branding_analysis y ux_assessment, tu JSON debe verse así:\n';
        deliverablesInstructions += '```json\n';
        deliverablesInstructions += '{\n';
        deliverablesInstructions += '  "site_info": { ... estructura base ... },\n';
        deliverablesInstructions += '  "blocks": [ ... estructura base ... ],\n';
        deliverablesInstructions += '  "structure_analysis": { ... estructura base ... },\n';
        deliverablesInstructions += '  "branding_analysis": { ... objeto completo si solicitado ... },\n';
        deliverablesInstructions += '  "ux_assessment": { ... objeto completo si solicitado ... }\n';
        deliverablesInstructions += '}\n';
        deliverablesInstructions += '```\n';
        deliverablesInstructions += '\n🔥 RECUERDA: Agrega los objetos deliverables AL MISMO NIVEL que "site_info", "blocks" y "structure_analysis".\n';
        
        enhancedUserMessage += deliverablesInstructions;
        console.log(`[structuredAnalyzerAgent] Prompt con deliverables específicos agregado (${deliverablesInstructions.length} caracteres)`);
      } else {
        console.log(`[structuredAnalyzerAgent] ❌ NO hay deliverables en el request - no se agregará nada al prompt`);
      }
      
      // Preparar el mensaje para la API con el mensaje mejorado que incluye HTML
      console.log(`[structuredAnalyzerAgent] Preparando mensaje para la API...`);
      console.log(`[structuredAnalyzerAgent] Prompt final tiene ${enhancedUserMessage.length} caracteres`);
      console.log(`[structuredAnalyzerAgent] Últimos 500 caracteres del prompt:`, enhancedUserMessage.slice(-500));
      
      const messages = prepareApiMessage(
        enhancedUserMessage,
        processedImage,
        STRUCTURED_ANALYZER_SYSTEM_PROMPT,
        request.options?.provider
      );
      console.log(`[structuredAnalyzerAgent] Mensaje preparado con ${messages.length} elementos`);
      
      // Realizar la llamada a la API
      console.log(`[structuredAnalyzerAgent] Realizando llamada a la API...`);
      const response = await callApiWithMessage(
        messages,
        request.options?.provider as 'anthropic' | 'openai' | 'gemini' || 'anthropic',
        request.options?.modelId
      );
      
      // Procesar la respuesta
      const responseContent = response.choices[0]?.message?.content || '';
      
      if (typeof responseContent === 'string') {
        try {
          // Intentar extraer el JSON de la respuesta
          const jsonMatch = responseContent.match(/```json\s*([\s\S]*?)\s*```/) || 
                           responseContent.match(/```\s*([\s\S]*?)\s*```/) ||
                           [null, responseContent];
          
          const jsonContent = jsonMatch[1].trim();
          
          // Intentar parsear el JSON
          let structuredAnalysis: StructuredAnalysisResponse;
          
          try {
            structuredAnalysis = JSON.parse(jsonContent);
            console.log(`[structuredAnalyzerAgent] JSON parseado correctamente sin necesidad de correcciones`);
          } catch (jsonError) {
            console.error(`[structuredAnalyzerAgent] Error al parsear JSON: ${jsonError}`);
            
            // Solo intentar sanitizar si realmente hay un error de parseo
            console.log(`[structuredAnalyzerAgent] JSON mal formado, intentando sanitizar...`);
            
            try {
              const sanitizedJson = await sanitizeJsonWithAgent(jsonContent, request.options?.provider, request.options?.modelId);
              structuredAnalysis = JSON.parse(sanitizedJson);
              console.log(`[structuredAnalyzerAgent] JSON sanitizado y parseado correctamente`);
            } catch (sanitizeError) {
              console.error(`[structuredAnalyzerAgent] Error al sanitizar JSON: ${sanitizeError}`);
              throw new Error(`No se pudo procesar el JSON de respuesta: ${jsonError}`);
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
  } catch (error) {
    console.error(`[structuredAnalyzerAgent] Error en el análisis estructurado: ${error}`);
    
    // Si falla, que falle - sin fallback dummy
    throw error;
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