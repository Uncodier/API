// Utilidades para manejar llamadas a la API y operaciones comunes
import { AnalyzeRequest } from '../types/analyzer-types';
import { getRequestOptions } from '../config/analyzer-config';
import { captureScreenshot, prepareImageForAPI } from './image-utils';
import { preprocessHtml } from './html-preprocessor';
import { createVisionMessage } from './message-utils';
import * as cheerio from 'cheerio';

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
  const includeScreenshot = request.options?.includeScreenshot !== false;
  
  console.log(`[prepareAnalysisData] includeScreenshot: ${includeScreenshot}, timeout: ${timeout}ms`);
  
  // Capturar screenshot si no se proporcionó y si no está explícitamente desactivado
  let screenshotData = request.screenshot;
  if (!screenshotData && includeScreenshot) {
    console.log('[prepareAnalysisData] Capturando screenshot...');
    screenshotData = await captureScreenshot(request.url, { timeout });
  } else if (!includeScreenshot) {
    console.log('[prepareAnalysisData] Screenshot desactivado por el usuario');
  }
  
  // Preparar la imagen para la API solo si tenemos screenshot
  const processedImage = screenshotData ? prepareImageForAPI(screenshotData) : undefined;
  
  // Obtener el HTML si no se proporcionó
  let htmlContent = request.htmlContent;
  if (!htmlContent) {
    console.log('[prepareAnalysisData] Obteniendo HTML...');
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
        maxTextLength: 200000 // Aumentar para asegurar que se capture la estructura completa
      };
      
      const preprocessResult = await preprocessHtml(request.url, preprocessOptions);
      htmlContent = preprocessResult.html;
      
      console.log(`[prepareAnalysisData] HTML preprocesado: ${htmlContent.length} bytes`);
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
      console.error(`[prepareAnalysisData] Error al obtener o procesar HTML: ${error}`);
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
    <p>No se pudo obtener el HTML completo debido a un error: ${error}</p>
  </main>
</body>
</html>`;
    }
  }
  
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
  modelType: 'anthropic' | 'openai' | 'gemini' = 'anthropic',
  modelId?: string
): Promise<any> {
  console.log(`[callApiWithMessage] Enviando solicitud a la API usando ${modelType} ${modelId || 'default'}...`);
  
  try {
    // Determinar si estamos en el cliente o en el servidor
    const isClient = typeof window !== 'undefined';
    
    if (isClient) {
      // En el cliente, usamos la API route
      const response = await fetch('/api/ai', {
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
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `Error en la API: ${response.status}`);
      }
      
      return await response.json();
    } else {
      // En el servidor, llamamos directamente a la API de Portkey
      // Importar Portkey usando require para evitar problemas
      const Portkey = require('portkey-ai').default;
      const { getRequestOptions } = require('../config/analyzer-config');
      
      // Mapeo de proveedores a claves virtuales
      const PROVIDER_TO_VIRTUAL_KEY: Record<string, string> = {
        'anthropic': process.env.ANTHROPIC_API_KEY || '',
        'openai': process.env.AZURE_OPENAI_API_KEY || '',
        'gemini': process.env.GEMINI_API_KEY || ''
      };
      
      // Obtener la clave virtual para el proveedor seleccionado
      const virtualKey = PROVIDER_TO_VIRTUAL_KEY[modelType] || PROVIDER_TO_VIRTUAL_KEY['anthropic'];
      
      // Crear una instancia de Portkey
      const portkey = new Portkey({
        apiKey: process.env.PORTKEY_API_KEY || '',
        virtualKey: virtualKey
      });
      
      // Obtener opciones de solicitud
      const requestOptions = getRequestOptions(modelType, modelId);
      
      // Configurar opciones del modelo según el tipo
      let modelOptions;
      
      switch(modelType) {
        case 'anthropic':
          modelOptions = {
            model: requestOptions.anthropic.model,
            max_tokens: requestOptions.anthropic.max_tokens,
          };
          break;
        case 'openai':
          modelOptions = {
            model: requestOptions.openai.model,
            max_tokens: requestOptions.openai.max_tokens,
          };
          break;
        case 'gemini':
          modelOptions = {
            model: requestOptions.gemini.model,
            max_tokens: requestOptions.gemini.max_tokens,
          };
          break;
        default:
          modelOptions = {
            model: requestOptions.anthropic.model,
            max_tokens: requestOptions.anthropic.max_tokens,
          };
      }
      
      // Realizar la solicitud directamente a Portkey
      console.log(`[callApiWithMessage] Llamando directamente a Portkey desde el servidor`);
      console.log(`[callApiWithMessage] Modelo: ${modelOptions.model}, Max tokens: ${modelOptions.max_tokens}, Proveedor: ${modelType}, Clave virtual: ${virtualKey}`);
      
      try {
        const response = await portkey.chat.completions.create({
          messages: messages,
          ...modelOptions
        });
        
        console.log(`[callApiWithMessage] Respuesta de Portkey recibida correctamente`);
        return response;
      } catch (portkeyError) {
        console.error(`[callApiWithMessage] Error de Portkey:`, portkeyError);
        throw portkeyError;
      }
    }
  } catch (error) {
    console.error('[callApiWithMessage] Error:', error);
    throw error;
  }
}

/**
 * Prepara un mensaje para la API con texto, imagen y sistema prompt
 */
export function prepareApiMessage(
  textContent: string,
  imageUrl: string | undefined,
  systemPrompt: string,
  provider: 'anthropic' | 'openai' | 'gemini' = 'anthropic'
): any[] {
  return createVisionMessage(textContent, imageUrl, systemPrompt, provider);
} 