// Servicio para el análisis detallado de sitios web
import { AnalyzeRequest, AnalyzeResponse } from '../types/analyzer-types';
import { DETAILED_ANALYZER_SYSTEM_PROMPT } from '../config/analyzer-config';
import { prepareApiMessage, callApiWithMessage } from '../utils/api-utils';
import { prepareImageForAPI } from '../utils/image-utils';
import { captureScreenshot } from '../utils/image-utils';
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
  };
}

// Extend the AnalyzeResponse interface to include rawResponse
interface ExtendedAnalyzeResponse extends AnalyzeResponse {
  rawResponse?: any;
}

/**
 * Realiza un análisis detallado de un sitio web basado en un análisis inicial
 */
export async function detailedAnalyzerAgent(initialAnalysis: AnalyzeResponse, request: ExtendedAnalyzeRequest): Promise<ExtendedAnalyzeResponse> {
  console.log(`[detailedAnalyzerAgent] Iniciando análisis detallado para: ${request.url}`);
  
  try {
    // Preparar la imagen para la API
    const processedImage = prepareImageForAPI(request.screenshot);
    
    // Determinar qué prompt usar basado en el idioma preferido (si está disponible)
    let promptTemplate;
    const promptPath = path.join(process.cwd(), 'src', 'app', 'api', 'site', 'analyze', 'detailed-prompt.txt');
    const promptEnPath = path.join(process.cwd(), 'src', 'app', 'api', 'site', 'analyze', 'detailed-prompt-en.txt');
    
    try {
      // Intentar cargar el prompt en el idioma preferido o el predeterminado
      if (request.options?.language === 'en' && fs.existsSync(promptEnPath)) {
        promptTemplate = fs.readFileSync(promptEnPath, 'utf8');
      } else if (fs.existsSync(promptPath)) {
        promptTemplate = fs.readFileSync(promptPath, 'utf8');
      } else {
        // Fallback al prompt hardcodeado si no se pueden cargar los archivos
        promptTemplate = `
        Analiza en detalle el siguiente sitio web:
        URL: {url}
        
        Análisis inicial:
        {initial_summary}
        
        Insights previos:
        {initial_insights}
        
        Proporciona un análisis detallado con la siguiente estructura en formato JSON:
        
        \`\`\`json
        {
          "detailed_analysis": "Análisis detallado de la experiencia de usuario (UX) y diseño de interfaz (UI)",
          "insights": [
            {
              "title": "Título del insight 1",
              "description": "Descripción detallada del insight 1",
              "type": "fortaleza|debilidad"
            },
            {
              "title": "Título del insight 2",
              "description": "Descripción detallada del insight 2",
              "type": "fortaleza|debilidad"
            }
          ],
          "recommendations": [
            {
              "issue": "Problema identificado 1",
              "recommendation": "Recomendación detallada 1",
              "impact": "Impacto esperado de implementar esta recomendación",
              "priority": "alta|media|baja"
            },
            {
              "issue": "Problema identificado 2",
              "recommendation": "Recomendación detallada 2",
              "impact": "Impacto esperado de implementar esta recomendación",
              "priority": "alta|media|baja"
            }
          ]
        }
        \`\`\`
        
        Enfócate en aspectos como:
        - Usabilidad y navegación
        - Jerarquía visual y estructura de la información
        - Consistencia de diseño y branding
        - Rendimiento y velocidad percibida
        - Accesibilidad y experiencia en dispositivos móviles
        - Claridad del mensaje y propuesta de valor
        
        Asegúrate de que tu respuesta sea un JSON válido y estructurado exactamente como se muestra arriba.
        `;
      }
      
      // Reemplazar placeholders en el prompt
      let userMessage = promptTemplate.replace('{url}', request.url);
      userMessage = userMessage.replace('{initial_summary}', initialAnalysis.summary || 'No disponible');
      userMessage = userMessage.replace('{initial_insights}', 
        initialAnalysis.insights ? initialAnalysis.insights.map(insight => `- ${insight}`).join('\n') : 'No disponibles'
      );
      
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
        try {
          // Intentar parsear la respuesta como JSON
          const jsonMatch = responseContent.match(/```json\s*([\s\S]*?)\s*```/) || 
                           responseContent.match(/```\s*([\s\S]*?)\s*```/) ||
                           [null, responseContent];
          
          const jsonContent = jsonMatch[1].trim();
          const parsedResponse = JSON.parse(jsonContent);
          
          // Construir el resultado a partir del JSON
          const result: ExtendedAnalyzeResponse = {
            summary: parsedResponse.detailed_analysis || initialAnalysis.summary || 'No se proporcionó un análisis detallado.',
            insights: parsedResponse.insights?.map((insight: any) => 
              typeof insight === 'string' ? insight : `${insight.title}: ${insight.description} (${insight.type})`
            ) || initialAnalysis.insights || [],
            recommendations: parsedResponse.recommendations?.map((rec: any) => ({
              issue: rec.issue || 'Problema no especificado',
              solution: rec.recommendation || 'Solución no especificada',
              priority: (rec.priority === 'alta' || rec.priority === 'high') ? 'high' : 
                       (rec.priority === 'baja' || rec.priority === 'low') ? 'low' : 'medium'
            })) || initialAnalysis.recommendations || [],
            metadata: {
              analyzed_by: request.options?.provider === 'openai' ? 'GPT' : 'Claude',
              timestamp: new Date().toISOString(),
              model_used: response.model || 'unknown',
              status: 'success'
            },
            screenshot: request.screenshot || initialAnalysis.screenshot,
            rawResponse: parsedResponse // Guardar la respuesta completa para uso futuro
          };
          
          console.log(`[detailedAnalyzerAgent] Análisis detallado completado con éxito (formato JSON)`);
          return result;
        } catch (jsonError) {
          console.warn(`[detailedAnalyzerAgent] Error al parsear JSON, usando formato de texto: ${jsonError}`);
          
          // Fallback al método anterior de extracción de texto si el JSON falla
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
          } else {
            // Usar las recomendaciones del análisis inicial si no hay nuevas
            recommendations = initialAnalysis.recommendations || [];
          }
          
          // Construir el resultado
          const result: ExtendedAnalyzeResponse = {
            summary,
            insights,
            recommendations,
            metadata: {
              analyzed_by: request.options?.provider === 'openai' ? 'GPT' : 'Claude',
              timestamp: new Date().toISOString(),
              model_used: response.model || 'unknown',
              status: 'success'
            },
            screenshot: request.screenshot || initialAnalysis.screenshot
          };
          
          console.log(`[detailedAnalyzerAgent] Análisis detallado completado con éxito (formato texto)`);
          return result;
        }
      } else {
        throw new Error('La respuesta de la API no tiene el formato esperado');
      }
    } catch (promptError) {
      console.error(`[detailedAnalyzerAgent] Error al cargar el prompt: ${promptError}`);
      throw promptError;
    }
  } catch (error) {
    console.error(`[detailedAnalyzerAgent] Error en el análisis detallado: ${error}`);
    
    // En caso de error, devolver el análisis inicial
    const result: ExtendedAnalyzeResponse = {
      ...initialAnalysis,
      metadata: {
        ...initialAnalysis.metadata,
        status: 'error',
      }
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
    language?: 'en' | 'es';
  } = {}
): Promise<AnalyzeResponse> {
  // Construir el objeto de solicitud
  const analyzeRequest: ExtendedAnalyzeRequest = {
    url,
    options
  };
  
  // Usar el screenshot del análisis inicial o capturar uno nuevo si es necesario
  if (!initialAnalysis.screenshot && options.includeScreenshot !== false) {
    console.log(`[performDetailedAnalysis] Capturando screenshot para ${url}...`);
    try {
      analyzeRequest.screenshot = await captureScreenshot(url, { timeout: options.timeout });
    } catch (error) {
      console.error(`[performDetailedAnalysis] Error al capturar screenshot: ${error}`);
    }
  } else {
    analyzeRequest.screenshot = initialAnalysis.screenshot;
  }
  
  // Realizar el análisis detallado
  return detailedAnalyzerAgent(initialAnalysis, analyzeRequest);
}

/**
 * Realiza un análisis completo (inicial + detallado) de un sitio web
 */
export async function completeAnalysis(request: ExtendedAnalyzeRequest): Promise<AnalyzeResponse> {
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