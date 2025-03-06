// Servicio para el análisis inicial de sitios web
import { AnalyzeRequest, AnalyzeResponse } from '../types/analyzer-types';
import { INITIAL_ANALYZER_SYSTEM_PROMPT } from '../config/analyzer-config';
import { prepareApiMessage, callApiWithMessage, prepareAnalysisData } from '../utils/api-utils';
import { captureScreenshot } from '../utils/image-utils';

/**
 * Genera un análisis básico para casos de error
 */
function generateBasicAnalysis(url: string): AnalyzeResponse {
  return {
    summary: `No se pudo analizar completamente ${url}. Por favor, intente nuevamente.`,
    insights: [
      'No se pudieron obtener insights debido a un error en el análisis.'
    ],
    recommendations: [
      {
        issue: 'Error en el análisis',
        solution: 'Intente nuevamente o verifique la URL proporcionada',
        priority: 'high'
      }
    ],
    metadata: {
      analyzed_by: 'Sistema (Error)',
      timestamp: new Date().toISOString(),
      model_used: 'none',
      status: 'pending'
    }
  };
}

/**
 * Realiza un análisis inicial de un sitio web
 */
export async function initialAnalyzerAgent(request: AnalyzeRequest): Promise<AnalyzeResponse> {
  console.log(`[initialAnalyzerAgent] Iniciando análisis inicial para: ${request.url}`);
  
  try {
    // Preparar los datos para el análisis
    const { processedImage, htmlContent } = await prepareAnalysisData(request);
    
    // Crear el mensaje para la API
    const userMessage = `
    Analiza el siguiente sitio web:
    URL: ${request.url}
    
    Proporciona:
    1. Un resumen conciso del propósito y contenido del sitio (3-5 oraciones)
    2. 3-5 insights sobre el diseño, usabilidad y contenido del sitio
    3. 2-3 recomendaciones específicas para mejorar el sitio
    
    Formato de respuesta:
    
    Análisis:
    [Resumen del sitio]
    
    Insights:
    - [Insight 1]
    - [Insight 2]
    - [Insight 3]
    
    Recomendaciones:
    - [Recomendación 1]: [Solución propuesta]
    - [Recomendación 2]: [Solución propuesta]
    `;
    
    // Preparar el mensaje para la API
    const messages = prepareApiMessage(
      userMessage,
      processedImage,
      INITIAL_ANALYZER_SYSTEM_PROMPT,
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
      const summaryMatch = responseContent.match(/(?:Análisis|Analysis):(.*?)(?:\n\n|\n(?=Insights|Fortalezas|Debilidades|Strengths|Weaknesses|Recomendaciones|Recommendations))/i);
      const insightsMatch = responseContent.match(/(?:Insights|Fortalezas y debilidades|Strengths and weaknesses):(.*?)(?:\n\n|\n(?=Recomendaciones|Recommendations))/i);
      const recommendationsMatch = responseContent.match(/(?:Recomendaciones|Recommendations):(.*)/i);
      
      // Extraer y formatear el resumen
      const summary = summaryMatch 
        ? summaryMatch[1].trim() 
        : 'No se pudo extraer un resumen del análisis.';
      
      // Extraer y formatear los insights
      let insights: string[] = [];
      if (insightsMatch) {
        insights = insightsMatch[1]
          .split(/\n-|\n\d+\./)
          .map((item: string) => item.trim())
          .filter((item: string) => item.length > 0);
      }
      
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
          const issue = parts[0]?.trim() || item;
          const solution = parts[1]?.trim() || 'No especificada';
          
          // Determinar la prioridad basada en palabras clave
          let priority: 'high' | 'medium' | 'low' = 'medium';
          const lowerItem = item.toLowerCase();
          
          if (lowerItem.includes('crítico') || lowerItem.includes('urgente') || 
              lowerItem.includes('importante') || lowerItem.includes('alta') ||
              lowerItem.includes('critical') || lowerItem.includes('urgent') ||
              lowerItem.includes('important') || lowerItem.includes('high')) {
            priority = 'high';
          } else if (lowerItem.includes('menor') || lowerItem.includes('baja') ||
                    lowerItem.includes('minor') || lowerItem.includes('low')) {
            priority = 'low';
          }
          
          return { issue, solution, priority };
        });
      }
      
      // Construir el resultado
      const result: AnalyzeResponse = {
        summary,
        insights,
        recommendations,
        metadata: {
          analyzed_by: request.options?.provider === 'openai' ? 'GPT' : 'Claude',
          timestamp: new Date().toISOString(),
          model_used: response.model || 'unknown',
          status: 'success'
        },
        screenshot: request.screenshot
      };
      
      console.log(`[initialAnalyzerAgent] Análisis inicial completado con éxito`);
      return result;
    } else {
      throw new Error('La respuesta de la API no tiene el formato esperado');
    }
  } catch (error) {
    console.error(`[initialAnalyzerAgent] Error en el análisis inicial: ${error}`);
    
    // Devolver un análisis básico en caso de error
    const basicAnalysis = generateBasicAnalysis(request.url);
    basicAnalysis.metadata.status = 'error';
    
    return basicAnalysis;
  }
}

/**
 * Realiza un análisis inicial de un sitio web con opciones
 */
export async function performInitialAnalysis(
  url: string, 
  options: { 
    depth?: number; 
    timeout?: number;
    includeScreenshot?: boolean;
    provider?: 'anthropic' | 'openai' | 'gemini';
    modelId?: string;
  } = {}
): Promise<AnalyzeResponse> {
  // Construir el objeto de solicitud
  const analyzeRequest: AnalyzeRequest = {
    url,
    options
  };
  
  // Capturar screenshot solo si no está explícitamente desactivado
  if (options.includeScreenshot !== false) {
    console.log(`[performInitialAnalysis] Capturando screenshot para ${url}...`);
    try {
      analyzeRequest.screenshot = await captureScreenshot(url, { timeout: options.timeout });
    } catch (error) {
      console.error(`[performInitialAnalysis] Error al capturar screenshot: ${error}`);
    }
  } else {
    console.log(`[performInitialAnalysis] Screenshot desactivado por el usuario para ${url}`);
  }
  
  // Realizar el análisis inicial
  return initialAnalyzerAgent(analyzeRequest);
}