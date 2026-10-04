// Utilidades para manejar llamadas a la API y operaciones comunes
import { AnalyzeRequest } from '../types/analyzer-types';
import { getRequestOptions } from '../config/analyzer-config';
import { captureScreenshot, prepareImageForAPI } from './image-utils';
import { preprocessHtml } from './html-preprocessor';
import { createVisionMessage } from './message-utils';
import * as cheerio from 'cheerio';
import { continueJsonGeneration, isIncompleteJson as isJsonIncomplete, attemptJsonRepair, extractResponseContent, updateResponseContent } from '@/lib/services/continuation-service';
import { createOpenRouterClient } from '@/lib/services/ai/openrouter';

/**
 * Prepara los datos para un análisis (screenshot y HTML)
 */
export async function prepareAnalysisData(request: AnalyzeRequest): Promise<{
  screenshotData: string | undefined;
  processedImage: string | undefined;
  htmlContent: string | undefined;
}> {
  // Aumentar el timeout por defecto para dar más tiempo a la carga de contenido dinámico
  const timeout = request.options?.timeout || 60000; // Aumentar a 60 segundos para sitios complejos
  const includeScreenshot = request.options?.includeScreenshot === true; // Asegurarse de que sea booleano
  
  console.log('[prepareAnalysisData] Iniciando preparación de datos');
  console.log(`[prepareAnalysisData] Opciones procesadas: includeScreenshot=${includeScreenshot}, timeout=${timeout}ms`);
  
  // Log all properties of the request object to check what's available
  console.log(`[prepareAnalysisData] Propiedades del objeto request: ${JSON.stringify(Object.keys(request))}`);
  
  // Specially check for htmlContent in request
  if ('htmlContent' in request) {
    console.log(`[prepareAnalysisData] htmlContent encontrado como propiedad directa de request`);
    if (request.htmlContent) {
      console.log(`[prepareAnalysisData] htmlContent tiene valor y longitud: ${request.htmlContent.length}`);
    } else {
      console.log(`[prepareAnalysisData] htmlContent está presente pero es undefined o null`);
    }
  } else {
    console.log(`[prepareAnalysisData] htmlContent NO está presente como propiedad de request`);
  }
  
  // Maybe it's in the options?
  if (request.options && 'htmlContent' in request.options) {
    console.log(`[prepareAnalysisData] htmlContent encontrado en request.options con longitud: ${(request.options as any).htmlContent.length}`);
  }
  
  console.log(`[prepareAnalysisData] Solicitud HTML en entrada: ${request.htmlContent ? `Si (${request.htmlContent.length} bytes)` : 'No'}`);
  
  // Capturar screenshot si no se proporcionó y si no está explícitamente desactivado
  let screenshotData = request.screenshot;
  if (!screenshotData && includeScreenshot) {
    console.log('[prepareAnalysisData] Capturando screenshot...');
    try {
      screenshotData = await captureScreenshot(request.url, { timeout });
      console.log(`[prepareAnalysisData] Screenshot capturado: ${screenshotData ? screenshotData.length : 0} bytes`);
    } catch (error) {
      console.error('[prepareAnalysisData] Error al capturar screenshot');
      screenshotData = undefined;
    }
  } else if (!includeScreenshot) {
    console.log('[prepareAnalysisData] Screenshot desactivado por el usuario');
  } else {
    console.log(`[prepareAnalysisData] Usando screenshot proporcionado: ${screenshotData ? screenshotData.length : 0} bytes`);
  }
  
  // Preparar la imagen para la API solo si tenemos screenshot
  let processedImage;
  if (screenshotData) {
    console.log('[prepareAnalysisData] Procesando imagen para API...');
    processedImage = prepareImageForAPI(screenshotData);
    console.log(`[prepareAnalysisData] Imagen procesada: ${processedImage ? 'disponible' : 'no disponible'}`);
  }
  
  // Obtener el HTML si no se proporcionó
  let htmlContent = request.htmlContent;
  if (!htmlContent) {
    console.log('[prepareAnalysisData] No se proporcionó HTML en la solicitud, obteniendo HTML...');
    try {
      // Usar el HTML preprocesado con opciones optimizadas para análisis estructural
      const preprocessOptions = {
        removeScripts: true,
        removeStyles: true,
        removeComments: true,
        removeInlineStyles: false,
        removeDataAttributes: false,
        simplifyClassNames: false,
        preserveSemanticElements: true,
        preserveHeadings: true,
        preserveForms: true,
        preserveLinks: true,
        preserveImages: true,
        simplifyImageAttributes: true,
        optimizeSvgs: true,
        preserveNavigation: true,
        preserveCTAs: true,
        maxTextNodeLength: 30, // Reducir para ahorrar espacio en textos
        maxTextLength: 200000, // Aumentar para asegurar que se capture la estructura completa
        cleanHead: true,
        cleanFooter: true,
        headExcludePatterns: [],
        footerExcludePatterns: []
      };
      
      const preprocessResult = await preprocessHtml(request.url, preprocessOptions);
      htmlContent = preprocessResult.html;
      
      console.log(`[prepareAnalysisData] HTML obtenido y preprocesado: ${htmlContent.length} bytes`);
      console.log(`[prepareAnalysisData] Estadísticas HTML: ${JSON.stringify(preprocessResult.stats)}`);
      
      // Verificar si el HTML es demasiado grande para el modelo
      if (htmlContent && htmlContent.length > 150000) {
        console.warn(`[prepareAnalysisData] HTML demasiado grande (${htmlContent.length} bytes), aplicando truncado inteligente...`);
        
        // Truncado inteligente que preserva la estructura DOM
        const $ = cheerio.load(htmlContent);
        
        // Definir elementos estructurales importantes
        const structuralSelectors = [
          // Elementos semánticos principales
          'header', 'nav', 'main', 'footer', 'aside', 'section', 'article',
          // Roles ARIA
          '[role="navigation"]', '[role="banner"]', '[role="main"]', '[role="contentinfo"]',
          // Clases comunes para elementos estructurales
          '.header', '.navbar', '.navigation', '.main', '.content', '.footer',
          '.container', '.wrapper', '.section', '.block', '.hero', '.features',
          '.testimonials', '.pricing', '.cta-section', '.contact'
        ];
        
        // Preservar atributos importantes para identificar la estructura
        const preserveAttributes = ['id', 'class', 'role', 'aria-label', 'data-section', 'data-component'];
        
        // Función para determinar si un elemento es estructuralmente importante
        const isStructuralElement = (el: cheerio.Cheerio<any>): boolean => {
          // Verificar si es un elemento semántico o tiene una clase/id estructural
          for (const selector of structuralSelectors) {
            if (el.is(selector)) return true;
          }
          
          // Verificar si tiene atributos que indican estructura
          for (const attr of preserveAttributes) {
            const attrValue = el.attr(attr);
            if (attrValue && (
              attrValue.includes('section') || 
              attrValue.includes('container') || 
              attrValue.includes('block') || 
              attrValue.includes('wrapper')
            )) {
              return true;
            }
          }
          
          return false;
        };
        
        // Función para procesar un elemento y sus hijos
        const processElement = (el: cheerio.Cheerio<any>, depth: number = 0, isStructural: boolean = false) => {
          // Determinar si este elemento es estructural
          const thisIsStructural = isStructural || isStructuralElement(el);
          
          // Procesar los hijos
          el.children().each(function() {
            const child = $(this);
            const childIsStructural = thisIsStructural || isStructuralElement(child);
            
            // Si es un elemento de texto y no es estructural, truncar
            if (!child.children().length && !childIsStructural && child.text().trim().length > 30) {
              child.text(child.text().trim().substring(0, 30) + '...');
            } else {
              // Procesar recursivamente
              processElement(child, depth + 1, childIsStructural);
            }
          });
          
          // Si no es estructural y tiene muchos hijos similares, simplificar
          if (!thisIsStructural && depth > 2) {
            const children = el.children();
            if (children.length > 5) {
              // Verificar si los hijos son similares (mismo tag)
              const firstTag = children.first().prop('tagName');
              let similarCount = 0;
              
              children.each(function() {
                if ($(this).prop('tagName') === firstTag) similarCount++;
              });
              
              // Si más del 80% son similares, mantener solo algunos
              if (similarCount / children.length > 0.8) {
                // Mantener los primeros 3 y eliminar el resto
                children.each(function(i) {
                  if (i > 2) $(this).remove();
                });
                
                // Añadir un comentario indicando elementos similares omitidos
                el.append(`<!-- ${children.length - 3} elementos similares omitidos -->`);
              }
            }
          }
        };
        
        // Procesar el body para preservar la estructura
        processElement($('body'), 0, true);
        
        // Regenerar el HTML
        htmlContent = $.html();
        console.log(`[prepareAnalysisData] HTML después del truncado inteligente: ${htmlContent.length} bytes`);
      }
    } catch (error) {
      console.error('[prepareAnalysisData] Error al obtener o procesar HTML');
      // Si hay un error, intentar devolver al menos un HTML básico con la información disponible
      htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <title>Error al procesar ${request.url}</title>
</head>
<body>
  <header>
    <h1>Sitio: ${request.url}</h1>
  </header>
  <main>
    <p>No se pudo obtener el HTML completo.</p>
  </main>
</body>
</html>`;
      console.log(`[prepareAnalysisData] Generado HTML de error básico (${htmlContent.length} bytes)`);
    }
  } else {
    console.log(`[prepareAnalysisData] Usando HTML proporcionado en la solicitud (${htmlContent.length} bytes)`);
  }
  
  console.log(`[prepareAnalysisData] Finalizando con resultados: screenshot=${!!screenshotData}, imagen procesada=${!!processedImage}, HTML=${!!htmlContent} (${htmlContent?.length || 0} bytes)`);
  
  return {
    screenshotData,
    processedImage,
    htmlContent
  };
}

/**
 * Realiza una llamada a la API con un mensaje y sistema prompt
 */
export async function callApiWithMessage(
  messages: any[],
  modelType: 'anthropic' | 'openai' | 'gemini' = 'openai',
  modelId?: string,
  processIncomplete = true
): Promise<any> {
  console.log(`[callApiWithMessage] Enviando solicitud a la API usando ${modelType} ${modelId || 'default'}...`);
  
  try {
    // Determinar si estamos en el cliente o en el servidor
    const isClient = typeof window !== 'undefined';
    
    let response;
    
    if (isClient) {
      // En el cliente, usamos la API route
      const apiResponse = await fetch('/api/ai', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages,
          modelType,
          modelId
        }),
      });
      
      if (!apiResponse.ok) {
        const errorData = await apiResponse.json();
        throw new Error(errorData.error || `Error en la API: ${apiResponse.status}`);
      }
      
      response = await apiResponse.json();
    } else {
      response = await createOpenRouterClient().chat.completions.create({
        ...getRequestOptions(modelType, modelId).openrouter,
        messages,
        stream: false,
      });
    }
    
    // Verificar si la respuesta contiene un JSON incompleto y manejarlo
    // Esto solo se aplica a respuestas que parecen ser JSON (comienzan con '{')
    const processedResponse = processIncomplete
      ? await handleIncompleteJsonResponse(response, messages, modelType, modelId) : response;
    
    return processedResponse;
  } catch (error) {
    console.error('[callApiWithMessage] OpenRouter request failed');
    throw new Error('OpenRouter request failed');
  }
}

/**
 * Prepara un mensaje para la API con texto, imagen y sistema prompt
 */
export function prepareApiMessage(
  textContent: string,
  imageUrl: string | undefined,
  systemPrompt: string,
  provider: 'anthropic' | 'openai' | 'gemini' = 'openai'
): any[] {
  // All OpenRouter vendors accept the OpenAI-compatible image_url format.
  return createVisionMessage(textContent, imageUrl, systemPrompt, 'openai');
}

/**
 * Maneja respuestas JSON incompletas utilizando el servicio de continuación
 * 
 * Esta función detecta si una respuesta contiene un JSON incompleto y utiliza
 * el servicio de continuación para completarlo.
 */
export async function handleIncompleteJsonResponse(
  response: any,
  messages: any[],
  modelType: 'anthropic' | 'openai' | 'gemini' = 'openai',
  modelId?: string
): Promise<any> {
  const content = extractResponseContent(response);
  
  // Verificar si la respuesta parece ser un JSON incompleto
  if (content && content.trim().startsWith('{') && isJsonIncomplete(content)) {
    console.log('[handleIncompleteJsonResponse] Detectada respuesta JSON incompleta');
    
    // Intentar primero con el método de reparación rápida
    const repairedJson = attemptJsonRepair(content);
    if (repairedJson) {
      console.log('[handleIncompleteJsonResponse] JSON reparado exitosamente sin usar IA');
      
      // Actualizar la respuesta con el JSON reparado
      updateResponseContent(response, JSON.stringify(repairedJson));
      
      return response;
    }
    
    console.log('[handleIncompleteJsonResponse] Intentando completar JSON con el servicio de continuación');
    
    try {
      // Usar el servicio de continuación para completar el JSON
      const continuationResult = await continueJsonGeneration({
        incompleteJson: content,
        modelType,
        modelId: modelId || getRequestOptions(modelType).openrouter.model,
        siteUrl: '', // No synthetic site fetch is needed for a text continuation.
        timeout: 30000,
        maxRetries: 2
      });
      if (continuationResult.generations?.length) {
        response.continuation_generations = [
          ...(response.continuation_generations || []), ...continuationResult.generations,
        ];
      }
      
      if (continuationResult.success && continuationResult.completeJson) {
        console.log('[handleIncompleteJsonResponse] JSON completado exitosamente con el servicio de continuación');
        
        // Actualizar la respuesta con el JSON completo
        const completedJsonString = typeof continuationResult.completeJson === 'string' 
          ? continuationResult.completeJson 
          : JSON.stringify(continuationResult.completeJson);
        
        updateResponseContent(response, completedJsonString);
        
        return response;
      }
      
      // Si el servicio de continuación falló, intentar con el método tradicional
      console.log('[handleIncompleteJsonResponse] El servicio de continuación falló, intentando con el método tradicional');
    } catch (error) {
      console.error('[handleIncompleteJsonResponse] Error en el servicio de continuación');
      console.log('[handleIncompleteJsonResponse] Intentando con el método tradicional');
    }
    
    // Método tradicional: solicitar continuación con un nuevo mensaje
    console.log('[handleIncompleteJsonResponse] Solicitando continuación con un nuevo mensaje');
    
    // Crear un nuevo mensaje para solicitar la continuación
    const continuationMessage = [
      ...messages,
      { role: 'assistant', content: content },
      { 
        role: 'user', 
        content: 'La respuesta JSON está incompleta. Por favor, continúa exactamente donde te quedaste sin repetir lo que ya has enviado. Completa el JSON.'
      }
    ];
    
    // Realizar una nueva llamada a la API para obtener la continuación
    // A continuation must not recursively launch another unbounded repair sequence.
    const continuationResponse = await callApiWithMessage(continuationMessage, modelType, modelId, false);
    response.continuation_generations = [
      ...(response.continuation_generations || []),
      { id: continuationResponse.id, provider: continuationResponse.provider,
        model: continuationResponse.model, usage: continuationResponse.usage },
    ];
    
    // Extraer el contenido de la continuación según el proveedor
    const continuationContent = extractResponseContent(continuationResponse);
    
    // Concatenar la respuesta original con la continuación
    const combinedContent = content + continuationContent;
    
    // Verificar si la respuesta combinada es un JSON válido
    if (!isJsonIncomplete(combinedContent)) {
      console.log('[handleIncompleteJsonResponse] Respuesta JSON completada correctamente');
      
      // Actualizar la respuesta con el contenido combinado
      updateResponseContent(response, combinedContent);
      
      return response;
    } else {
      // Si aún no es válido, intentar extraer un JSON válido
      console.log('[handleIncompleteJsonResponse] La respuesta combinada aún no es un JSON válido, intentando extraer...');
      const extractedJson = extractValidJson(combinedContent);
      
      if (extractedJson) {
        console.log('[handleIncompleteJsonResponse] JSON válido extraído correctamente');
        
        // Actualizar la respuesta con el JSON extraído
        updateResponseContent(response, extractedJson);
      }
      
      return response;
    }
  }
  
  // Si la respuesta ya es válida, devolverla sin cambios
  return response;
}

/**
 * Verifica si una cadena es un JSON válido
 * @param str La cadena a verificar
 * @returns true si es un JSON válido, false en caso contrario
 */
function isValidJson(str: string): boolean {
  try {
    JSON.parse(str);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Intenta extraer un objeto JSON válido de una cadena
 * @param str La cadena que contiene un JSON potencialmente incompleto
 * @returns El JSON extraído como cadena o null si no se pudo extraer
 */
function extractValidJson(str: string): string | null {
  // Buscar el inicio del JSON
  const startIndex = str.indexOf('{');
  if (startIndex === -1) return null;
  
  // Contar llaves para encontrar el final del JSON
  let openBraces = 0;
  let endIndex = -1;
  
  for (let i = startIndex; i < str.length; i++) {
    if (str[i] === '{') openBraces++;
    else if (str[i] === '}') {
      openBraces--;
      if (openBraces === 0) {
        endIndex = i + 1;
        break;
      }
    }
  }
  
  // Si encontramos un JSON completo, extraerlo
  if (endIndex !== -1) {
    const jsonStr = str.substring(startIndex, endIndex);
    if (isValidJson(jsonStr)) {
      return jsonStr;
    }
  }
  
  return null;
}

/**
 * Formatea y estructura una respuesta JSON para la API de conversación
 * 
 * @param content El contenido de la respuesta que puede contener JSON
 * @param requestedJson Indica si se solicitó explícitamente una respuesta en formato JSON
 * @returns Un objeto con la respuesta procesada y metadatos sobre el formato JSON
 */
export function formatJsonResponse(content: string, requestedJson: boolean = false): {
  content: string;
  extractedJson: any | null;
  isJsonResponse: boolean;
  formattedJson: string | null;
} {
  // Resultado por defecto
  const result = {
    content,
    extractedJson: null,
    isJsonResponse: false,
    formattedJson: null as string | null
  };

  // Si no hay contenido, devolver el resultado por defecto
  if (!content) return result;

  // Verificar si el contenido es un JSON completo
  if (isValidJson(content)) {
    try {
      const jsonData = JSON.parse(content);
      result.extractedJson = jsonData;
      result.isJsonResponse = true;
      result.formattedJson = JSON.stringify(jsonData, null, 2);
      return result;
    } catch (e) {
      // Si hay un error al parsear, continuar con la extracción
    }
  }

  // Intentar extraer JSON del contenido
  const jsonPattern = /```(?:json)?\s*({[\s\S]*?})\s*```|({[\s\S]*?})/g;
  let match;
  let extractedJson = null;

  while ((match = jsonPattern.exec(content)) !== null) {
    const jsonStr = (match[1] || match[2]).trim();
    if (isValidJson(jsonStr)) {
      extractedJson = JSON.parse(jsonStr);
      break;
    }
  }

  // Si no se encontró JSON con el patrón, intentar con extractValidJson
  if (!extractedJson) {
    const validJsonStr = extractValidJson(content);
    if (validJsonStr) {
      extractedJson = JSON.parse(validJsonStr);
    }
  }

  // Si se encontró JSON, actualizar el resultado
  if (extractedJson) {
    result.extractedJson = extractedJson;
    result.isJsonResponse = true;
    result.formattedJson = JSON.stringify(extractedJson, null, 2);

    // Si se solicitó explícitamente JSON, reemplazar el contenido con el JSON formateado
    if (requestedJson) {
      result.content = result.formattedJson || content;
    }
  }

  return result;
} 