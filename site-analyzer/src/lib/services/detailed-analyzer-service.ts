// Servicio para el análisis detallado de sitios web
import { AnalyzeRequest, AnalyzeResponse } from '../types/analyzer-types';
import { DETAILED_ANALYZER_SYSTEM_PROMPT } from '../config/analyzer-config';
import { prepareApiMessage, callApiWithMessage } from '../utils/api-utils';
import { prepareImageForAPI } from '../utils/image-utils';
import { captureScreenshot } from '../utils/image-utils';

/**
 * Realiza un análisis detallado de un sitio web basado en un análisis inicial
 */
export async function detailedAnalyzerAgent(initialAnalysis: AnalyzeResponse, request: AnalyzeRequest): Promise<AnalyzeResponse> {
  console.log(`[detailedAnalyzerAgent] Iniciando análisis detallado para: ${request.url}`);
  
  try {
    // Preparar la imagen para la API
    const processedImage = prepareImageForAPI(request.screenshot);
    
    // Crear el mensaje para la API
    const userMessage = `
    Analiza en detalle el siguiente sitio web:
    URL: ${request.url}
    
    Análisis inicial:
    ${initialAnalysis.summary}
    
    Insights previos:
    ${initialAnalysis.insights.map(insight => `- ${insight}`).join('\n')}
    
    Proporciona:
    1. Un análisis detallado de la experiencia de usuario (UX) y diseño de interfaz (UI)
    2. 5-7 insights específicos sobre fortalezas y debilidades del sitio
    3. 3-5 recomendaciones concretas y accionables para mejorar el sitio, ordenadas por prioridad
    
    Enfócate en aspectos como:
    - Usabilidad y navegación
    - Jerarquía visual y estructura de la información
    - Consistencia de diseño y branding
    - Rendimiento y velocidad percibida
    - Accesibilidad y experiencia en dispositivos móviles
    - Claridad del mensaje y propuesta de valor
    `;
    
    // Preparar el mensaje para la API
    const messages = prepareApiMessage(
      userMessage,
      processedImage,
      DETAILED_ANALYZER_SYSTEM_PROMPT,
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
    
    if (typeof responseContent === 'string') {
      // Extraer las secciones de la respuesta
      const summaryMatch = responseContent.match(/(?:Análisis detallado|Detailed analysis):(.*?)(?:\n\n|\n(?=Insights|Fortalezas|Debilidades|Strengths|Weaknesses|Recomendaciones|Recommendations))/i);
      const insightsMatch = responseContent.match(/(?:Insights|Fortalezas y debilidades|Strengths and weaknesses):(.*?)(?:\n\n|\n(?=Recomendaciones|Recommendations))/i);
      const recommendationsMatch = responseContent.match(/(?:Recomendaciones|Recommendations):(.*)/i);
      
      // Extraer y formatear el resumen
      const summary = summaryMatch 
        ? summaryMatch[1].trim() 
        : initialAnalysis.summary || 'No se pudo extraer un análisis detallado.';
      
      // Extraer y formatear los insights
      let insights: string[] = [];
      if (insightsMatch) {
        insights = insightsMatch[1]
          .split(/\n-|\n\d+\./)
          .map((item: string) => item.trim())
          .filter((item: string) => item.length > 0);
      } else {
        // Usar los insights del análisis inicial si no hay nuevos
        insights = initialAnalysis.insights || [];
      }
      
      // Eliminar duplicados en insights
      const uniqueInsights = new Set<string>();
      for (const insight of insights) {
        uniqueInsights.add(insight);
      }
      insights = Array.from(uniqueInsights);
      
      // Extraer y formatear las recomendaciones
      let recommendations: Array<{issue: string; solution: string; priority: 'high' | 'medium' | 'low'}> = [];
      if (recommendationsMatch) {
        const recommendationsText = recommendationsMatch[1];
        const recommendationItems = recommendationsText
          .split(/\n-|\n\d+\./)
          .map((item: string) => item.trim())
          .filter((item: string) => item.length > 0);
        
        recommendations = recommendationItems.map((item: string) => {
          // Intentar extraer el problema y la solución
          const parts = item.split(/:\s*|–\s*|-\s*/, 2);
          
          let issue = '';
          let solution = '';
          
          if (parts.length >= 2) {
            issue = parts[0].trim();
            solution = parts[1].trim();
          } else {
            // Si no se puede dividir, usar todo como solución
            solution = item;
            // Intentar generar un issue basado en las primeras palabras
            const words = solution.split(' ').slice(0, 3).join(' ');
            issue = `Problema con ${words}...`;
          }
          
          // Determinar la prioridad basada en palabras clave
          let priority: 'high' | 'medium' | 'low' = 'medium';
          const lowerItem = item.toLowerCase();
          
          if (lowerItem.includes('crítico') || lowerItem.includes('urgente') || 
              lowerItem.includes('importante') || lowerItem.includes('critical') ||
              lowerItem.includes('urgent') || lowerItem.includes('high priority')) {
            priority = 'high';
          } else if (lowerItem.includes('menor') || lowerItem.includes('pequeño') || 
                    lowerItem.includes('minor') || lowerItem.includes('low priority')) {
            priority = 'low';
          }
          
          return { issue, solution, priority };
        });
      } else {
        // Usar las recomendaciones del análisis inicial si no hay nuevas
        recommendations = initialAnalysis.recommendations || [];
      }
      
      // Crear el objeto de respuesta
      const result: AnalyzeResponse = {
        summary,
        insights,
        recommendations,
        metadata: {
          analyzed_by: `${request.options?.provider === 'openai' ? 'GPT' : 'Claude'} (Detallado)`,
          timestamp: new Date().toISOString(),
          model_used: request.options?.modelId || (request.options?.provider === 'openai' ? 'gpt-4-vision-preview' : 'claude-3-opus-20240229'),
          status: 'success'
        },
        screenshot: request.screenshot
      };
      
      console.log('[detailedAnalyzerAgent] Análisis detallado completado con éxito');
      return result;
    } else {
      throw new Error('La respuesta de la API no tiene el formato esperado');
    }
  } catch (error) {
    console.error(`[detailedAnalyzerAgent] Error en el análisis detallado: ${error}`);
    
    // En caso de error, devolver el análisis inicial con estado actualizado
    const result = { ...initialAnalysis };
    result.metadata = {
      ...initialAnalysis.metadata,
      analyzed_by: 'Claude (Error en detallado)',
      timestamp: new Date().toISOString(),
      status: 'error'
    };
    
    return result;
  }
}

/**
 * Realiza un análisis detallado de un sitio web con opciones
 */
export async function performDetailedAnalysis(
  url: string, 
  initialAnalysis: AnalyzeResponse,
  options: { 
    timeout?: number;
    includeScreenshot?: boolean;
    provider?: 'anthropic' | 'openai' | 'gemini';
    modelId?: string;
  } = {}
): Promise<AnalyzeResponse> {
  // Construir el objeto de solicitud
  const analyzeRequest: AnalyzeRequest = {
    url,
    options,
    // Usar el screenshot del análisis inicial si existe y no está desactivado explícitamente
    screenshot: options.includeScreenshot !== false ? initialAnalysis.screenshot : undefined
  };
  
  // Si no tenemos screenshot del análisis inicial y no está desactivado explícitamente, intentar capturar uno
  if (!analyzeRequest.screenshot && options.includeScreenshot !== false) {
    console.log(`[performDetailedAnalysis] No hay screenshot del análisis inicial, capturando para ${url}...`);
    try {
      analyzeRequest.screenshot = await captureScreenshot(url, { timeout: options.timeout });
    } catch (error) {
      console.error(`[performDetailedAnalysis] Error al capturar screenshot: ${error}`);
    }
  } else if (options.includeScreenshot === false) {
    console.log(`[performDetailedAnalysis] Screenshot desactivado por el usuario para ${url}`);
  }
  
  // Realizar el análisis detallado
  return detailedAnalyzerAgent(initialAnalysis, analyzeRequest);
}

/**
 * Realiza un análisis completo (inicial + detallado) de un sitio web
 */
export async function completeAnalysis(request: AnalyzeRequest): Promise<AnalyzeResponse> {
  try {
    // Realizar análisis inicial
    console.log(`[completeAnalysis] Iniciando análisis completo para: ${request.url}`);
    const initialResult = await import('./initial-analyzer-service').then(module => 
      module.initialAnalyzerAgent(request)
    );
    
    // Si el análisis inicial falló, devolver ese resultado
    if (initialResult.metadata.status === 'error') {
      console.warn('[completeAnalysis] El análisis inicial falló, no se realizará análisis detallado');
      return initialResult;
    }
    
    // Realizar análisis detallado
    console.log('[completeAnalysis] Análisis inicial completado, iniciando análisis detallado');
    const detailedResult = await detailedAnalyzerAgent(initialResult, request);
    
    return detailedResult;
  } catch (error) {
    console.error(`[completeAnalysis] Error en el análisis completo: ${error}`);
    
    // Devolver un análisis básico en caso de error
    return {
      summary: `Error al analizar ${request.url}`,
      insights: ['No se pudo completar el análisis'],
      recommendations: [
        {
          issue: 'Error en el análisis',
          solution: 'Intente nuevamente más tarde',
          priority: 'high'
        }
      ],
      metadata: {
        analyzed_by: 'Sistema (Error)',
        timestamp: new Date().toISOString(),
        model_used: 'none',
        status: 'error'
      }
    };
  }
} 