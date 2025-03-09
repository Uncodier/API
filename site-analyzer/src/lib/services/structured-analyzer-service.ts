// Servicio para el análisis estructurado de sitios web
import { AnalyzeRequest, StructuredAnalysisResponse } from '../types/analyzer-types';
import { STRUCTURED_ANALYZER_SYSTEM_PROMPT } from '../config/analyzer-config';
import { prepareAnalysisData, callApiWithMessage, prepareApiMessage } from '../utils/api-utils';
import { captureScreenshot } from '../utils/image-utils';
import { createBasicMessage } from '../utils/message-utils';

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
        selector: 'header',
        classes: [],
        content_type: 'mixed',
        description: 'Main header with navigation',
        business_objective: 'navigation',
        user_need: 'site navigation',
        ux_role: 'navigation',
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
        sub_blocks: []
      },
      {
        id: 'main-content',
        type: 'content',
        section_type: 'content',
        selector: 'main',
        classes: [],
        content_type: 'text',
        description: 'Main content area',
        business_objective: 'information',
        user_need: 'access information',
        ux_role: 'information',
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
        sub_blocks: []
      },
      {
        id: 'footer-block',
        type: 'footer',
        section_type: 'navigation',
        selector: 'footer',
        classes: [],
        content_type: 'mixed',
        description: 'Footer with additional links',
        business_objective: 'navigation',
        user_need: 'additional resources',
        ux_role: 'navigation',
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
        sub_blocks: []
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
export async function structuredAnalyzerAgent(request: AnalyzeRequest): Promise<StructuredAnalysisResponse> {
  console.log(`[structuredAnalyzerAgent] Starting structured analysis for: ${request.url}`);
  
  try {
    // Preparar los datos para el análisis
    const { processedImage, htmlContent } = await prepareAnalysisData(request);
    
    // Crear el mensaje para la API
    const userMessage = `
    Analyze the structure of the following website and provide a comprehensive analysis in JSON format:
    URL: ${request.url}
    
    ${htmlContent ? `HTML (site structure): 
\`\`\`html
${htmlContent}
\`\`\`
` : 'HTML not available'}
    
    IMPORTANT: This HTML has been captured from the rendered DOM and preprocessed to maintain the complete structure.
    
    FOCUS ON FUNCTIONAL BLOCKS AND THEIR CONTENT:
    - Identify the main sections such as header, hero, features, testimonials, pricing, footer
    - For each block, extract the MAIN TEXT CONTENT and organize it as a simple list
    - Include headings, paragraphs, and important text from interactive elements
    - Maintain the overall structure analysis (navigation, CTAs, forms, etc.)
    
    EXTRACT DOM IDs AND SELECTORS:
    - For EACH block, extract the actual DOM 'id' attribute if available (not making one up)
    - If an element doesn't have an id attribute in the DOM, use a descriptive selector that uniquely identifies it
    - For navigation elements, identify them based on HTML structure (nav, menu, ul/li patterns in headers/footers)
    - Ensure that ALL detected menu/navigation elements are included in the navigation_elements section
    
    YOUR PRIMARY GOAL is to provide a comprehensive analysis that includes:
    1. All major functional blocks with their content as simple text lists
    2. The hierarchy and relationship between these blocks
    3. The navigation structure
    4. Call-to-action elements
    5. Forms
    6. Key UX patterns and findings
    
    Respond with a JSON object that follows exactly this structure:
    
    {
      "site_info": {
        "url": "Site URL",
        "title": "Page title",
        "description": "Site description or purpose",
        "language": "Main site language"
      },
      "blocks": [
        {
          "id": "actual-dom-id-if-available", // Use the actual DOM id attribute, NOT a generated one
          "type": "Block type (header, hero, features, etc.)",
          "section_type": "Functional purpose (navigation, content, cta, form, etc.)",
          "selector": "CSS selector that uniquely identifies this element",
          "description": "Description of the block's purpose and content",
          "business_objective": "Business objective this block fulfills",
          "user_need": "User need this block satisfies",
          "content_list": [
            "First important text element in this block",
            "Second important text element in this block",
            "Third important text element in this block"
          ],
          "sub_blocks": [
            {
              "type": "Sub-block type (heading, paragraph, image, cta, form, button, etc.)",
              "selector": "CSS selector for this sub-element",
              "text": "Main text of the sub-block",
              "function": "Specific function of the sub-block",
              "interactive": true/false
            }
          ]
        }
      ],
      "hierarchy": {
        "main_sections": ["Main functional blocks"],
        "navigation_structure": [
          {
            "name": "Main menu",
            "location": "header",
            "items": ["Home", "Products", "Contact"]
          }
        ],
        "user_flow": {
          "primary_path": ["Homepage", "Catalog", "Product Detail", "Cart", "Checkout"]
        }
      },
      "ux_analysis": {
        "cta_elements": [
          {
            "text": "Buy now",
            "type": "primary",
            "purpose": "purchase",
            "location": "hero",
            "prominence": "high",
            "selector": "CSS selector for this CTA"
          }
        ],
        "navigation_elements": [
          {
            "type": "main-menu",
            "location": "header",
            "style": "horizontal",
            "items": ["Home", "Products", "Services", "Contact"],
            "selector": "CSS selector for this navigation element"
          }
        ],
        "forms": [
          {
            "purpose": "contact",
            "fields": ["name", "email", "message"],
            "location": "footer",
            "selector": "CSS selector for this form"
          }
        ]
      },
      "overview": {
        "total_blocks": 15,
        "primary_content_blocks": 5,
        "navigation_blocks": 2,
        "interactive_elements": 8,
        "key_ux_patterns": [
          "Header with horizontal navigation and prominent CTA",
          "Hero with clear value proposition and contrasting CTA",
          "Feature grid with icons and brief descriptions"
        ],
        "design_system_characteristics": [
          "Consistent use of rounded corners for interactive elements",
          "Limited color palette with blue as primary color",
          "Sans-serif typography for all content with weight variations for hierarchy"
        ]
      },
      "metadata": {
        "analyzed_by": "Model name",
        "timestamp": "Analysis date and time",
        "model_used": "Model used",
        "status": "success/error/pending"
      }
    }
    
    IMPORTANT GUIDELINES:
    1. Make sure each block includes a "content_list" field with actual text content
    2. Extract ALL meaningful text from each section
    3. Keep the overall structure analysis (navigation, CTAs, forms, etc.)
    4. Focus on user-facing content
    5. Include all major sections of the page
    6. For each block, use the actual DOM id if available, otherwise create a meaningful selector
    7. ALL detected menus/navigation elements MUST be included in the navigation_elements section
    
    Make sure the JSON is valid and follows exactly the structure provided.
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
        
        try {
          parsedResponse = JSON.parse(cleanedJsonString);
        } catch (cleanedParseError) {
          console.error('[structuredAnalyzerAgent] Error al parsear JSON limpio:', cleanedParseError);
          
          // Si la limpieza básica falló, intentar con el agente de saneamiento
          console.log('[structuredAnalyzerAgent] Solicitando saneamiento de JSON a otro agente');
          const sanitizedJsonString = await sanitizeJsonWithAgent(
            jsonString, 
            request.options?.provider as 'anthropic' | 'openai' | 'gemini' || 'anthropic',
            request.options?.modelId
          );
          
          try {
            parsedResponse = JSON.parse(sanitizedJsonString);
            console.log('[structuredAnalyzerAgent] JSON saneado parseado correctamente');
          } catch (sanitizedParseError) {
            console.error('[structuredAnalyzerAgent] Error al parsear JSON saneado:', sanitizedParseError);
            // Si todo falla, lanzar el error original
            throw parseError;
          }
        }
      }
      
      console.log('[structuredAnalyzerAgent] JSON parseado correctamente. Claves:', Object.keys(parsedResponse));
      
      // Asegurarse de que la respuesta tiene la estructura esperada
      if (parsedResponse.site_info && Array.isArray(parsedResponse.blocks)) {
        console.log(`[structuredAnalyzerAgent] Valid structure. Blocks found: ${parsedResponse.blocks.length}`);
        
        // Convertir la respuesta al formato completo esperado
        const fullResponse: StructuredAnalysisResponse = {
          site_info: parsedResponse.site_info,
          blocks: parsedResponse.blocks.map((block: any) => {
            // Asegurarse de que cada bloque tenga un content_list
            if (!block.content_list) {
              block.content_list = [];
              
              // Intentar extraer contenido de texto de sub_blocks si existe
              if (block.sub_blocks && Array.isArray(block.sub_blocks)) {
                block.sub_blocks.forEach((subBlock: any) => {
                  if (subBlock.text) {
                    block.content_list.push(subBlock.text);
                  }
                });
              }
            }
            
            // Crear un objeto BlockInfo completo
            return {
              id: block.id || `block-${Math.random().toString(36).substring(2, 9)}`,
              type: block.type || 'unknown',
              section_type: block.section_type || 'content',
              selector: block.selector || 'body',
              classes: block.classes || [],
              content_type: block.content_type || 'text',
              description: block.description || `${block.type} section`,
              business_objective: block.business_objective || 'information',
              user_need: block.user_need || 'access information',
              ux_role: block.ux_role || 'information',
              relevance: block.relevance || {
                score: 80,
                reason: 'Automatically assigned relevance'
              },
              children: block.children || 0,
              text_length: block.text_length || (block.content_list ? block.content_list.join(' ').length : 0),
              location: block.location || {
                position: 'middle',
                coordinates: {
                  top: 0,
                  left: 0
                }
              },
              content_list: block.content_list || [],
              sub_blocks: block.sub_blocks || []
            };
          }),
          hierarchy: parsedResponse.hierarchy || {
            main_sections: parsedResponse.blocks.map((block: any) => block.type),
            navigation_structure: [],
            user_flow: {
              primary_path: []
            }
          },
          ux_analysis: parsedResponse.ux_analysis || {
            cta_elements: [],
            navigation_elements: [],
            forms: []
          },
          overview: parsedResponse.overview || {
            total_blocks: parsedResponse.blocks.length,
            primary_content_blocks: parsedResponse.blocks.length,
            navigation_blocks: 0,
            interactive_elements: 0,
            key_ux_patterns: [],
            design_system_characteristics: []
          },
          metadata: {
            analyzed_by: `${request.options?.provider === 'openai' ? 'GPT' : 'Claude'} (Comprehensive)`,
            timestamp: new Date().toISOString(),
            model_used: request.options?.modelId || (request.options?.provider === 'openai' ? 'gpt-4-vision-preview' : 'claude-3-opus-20240229'),
            status: 'success'
          }
        };
        
        return fullResponse;
      } else {
        console.error('[structuredAnalyzerAgent] The response does not have the expected structure:', 
          'site_info:', !!parsedResponse.site_info, 
          'blocks:', Array.isArray(parsedResponse.blocks) ? parsedResponse.blocks.length : 'not an array');
        
        // Intentar recuperar la estructura si es posible
        if (parsedResponse.structuredAnalysis && 
            parsedResponse.structuredAnalysis.site_info && 
            Array.isArray(parsedResponse.structuredAnalysis.blocks)) {
          console.log('[structuredAnalyzerAgent] Found nested structure in structuredAnalysis');
          return {
            ...parsedResponse.structuredAnalysis,
            metadata: {
              analyzed_by: `${request.options?.provider === 'openai' ? 'GPT' : 'Claude'} (Simplified)`,
              timestamp: new Date().toISOString(),
              model_used: request.options?.modelId || (request.options?.provider === 'openai' ? 'gpt-4-vision-preview' : 'claude-3-opus-20240229'),
              status: 'success'
            }
          };
        }
        
        // Devolver un análisis básico en caso de error
        const basicAnalysis = generateBasicStructuredAnalysis(request.url);
        basicAnalysis.metadata.status = 'error';
        basicAnalysis.metadata.analyzed_by = `${request.options?.provider === 'openai' ? 'GPT' : 'Claude'} (Error in structured analysis)`;
        basicAnalysis.metadata.model_used = request.options?.modelId || (request.options?.provider === 'openai' ? 'gpt-4-vision-preview' : 'claude-3-opus-20240229');
        
        return basicAnalysis;
      }
    } catch (error) {
      console.error(`[structuredAnalyzerAgent] Error processing JSON response: ${error}`);
      throw new Error(`Error processing JSON response: ${error}`);
    }
  } catch (error) {
    console.error(`[structuredAnalyzerAgent] Error in structured analysis: ${error}`);
    
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
  console.log(`[performStructuredAnalysis] Starting structured analysis for ${url}`);
  
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
    console.log(`[performStructuredAnalysis] Capturing screenshot for ${url}...`);
    try {
      analyzeRequest.screenshot = await captureScreenshot(url, { timeout: options.timeout });
    } catch (error) {
      console.error(`[performStructuredAnalysis] Error capturing screenshot: ${error}`);
    }
  } else {
    console.log(`[performStructuredAnalysis] Screenshot disabled by user for ${url}`);
  }
  
  // Realizar el análisis estructurado
  try {
    const result = await structuredAnalyzerAgent(analyzeRequest);
    
    // Verificar que el resultado tenga la estructura esperada
    if (!result.site_info || !Array.isArray(result.blocks)) {
      console.error('[performStructuredAnalysis] The result does not have the expected structure');
      console.log('[performStructuredAnalysis] Received structure:', Object.keys(result));
      
      // Intentar recuperar la estructura si está anidada
      if (result && 
          typeof result === 'object' && 
          'structuredAnalysis' in result && 
          result.structuredAnalysis && 
          typeof result.structuredAnalysis === 'object' &&
          'site_info' in result.structuredAnalysis && 
          'blocks' in result.structuredAnalysis && 
          Array.isArray(result.structuredAnalysis.blocks)) {
        console.log('[performStructuredAnalysis] Found nested structure in structuredAnalysis');
        return result.structuredAnalysis as StructuredAnalysisResponse;
      }
      
      // Si no se puede recuperar, devolver un análisis básico
      return generateBasicStructuredAnalysis(url);
    }
    
    // Asegurarse de que blocks sea un array
    if (!Array.isArray(result.blocks)) {
      console.warn('[performStructuredAnalysis] blocks is not an array, fixing...');
      result.blocks = [];
    }
    
    // Asegurarse de que hierarchy y overview existan
    if (!result.hierarchy) {
      console.warn('[performStructuredAnalysis] hierarchy does not exist, initializing...');
      result.hierarchy = {
        main_sections: [],
        navigation_structure: []
      };
    }
    
    if (!result.overview) {
      console.warn('[performStructuredAnalysis] overview does not exist, initializing...');
      result.overview = {
        total_blocks: result.blocks.length,
        primary_content_blocks: 0,
        navigation_blocks: 0,
        interactive_elements: 0
      };
    }
    
    // Asegurarse de que metadata exista
    if (!result.metadata) {
      console.warn('[performStructuredAnalysis] metadata does not exist, initializing...');
      result.metadata = {
        analyzed_by: `${options.provider === 'openai' ? 'GPT' : 'Claude'} (Simplified)`,
        timestamp: new Date().toISOString(),
        model_used: options.modelId || (options.provider === 'openai' ? 'gpt-4-vision-preview' : 'claude-3-opus-20240229'),
        status: 'success'
      };
    }
    
    console.log(`[performStructuredAnalysis] Analysis completed successfully. Blocks: ${result.blocks.length}`);
    return result;
  } catch (error) {
    console.error(`[performStructuredAnalysis] Error in structured analysis: ${error}`);
    
    // Devolver un análisis básico en caso de error
    const basicAnalysis = generateBasicStructuredAnalysis(url);
    basicAnalysis.metadata.status = 'error';
    
    return basicAnalysis;
  }
}