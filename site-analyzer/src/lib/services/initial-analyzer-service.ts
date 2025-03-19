// Servicio para el análisis inicial de sitios web
import { AnalyzeRequest, AnalyzeResponse } from '../types/analyzer-types';
import { INITIAL_ANALYZER_SYSTEM_PROMPT } from '../config/analyzer-config';
import { prepareApiMessage, callApiWithMessage, prepareAnalysisData } from '../utils/api-utils';
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
    language?: 'en' | 'es'; // Add language option
  };
}

// Extend the AnalyzeResponse interface to include rawResponse
interface ExtendedAnalyzeResponse extends AnalyzeResponse {
  rawResponse?: any;
}

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
export async function initialAnalyzerAgent(request: ExtendedAnalyzeRequest): Promise<ExtendedAnalyzeResponse> {
  console.log(`[initialAnalyzerAgent] Iniciando análisis inicial para: ${request.url}`);
  
  try {
    // Preparar los datos para el análisis
    const { processedImage, htmlContent } = await prepareAnalysisData(request);
    
    // Determinar qué prompt usar basado en el idioma preferido (si está disponible)
    let promptTemplate;
    const promptPath = path.join(process.cwd(), 'src', 'app', 'api', 'site', 'analyze', 'prompt.txt');
    const promptEnPath = path.join(process.cwd(), 'src', 'app', 'api', 'site', 'analyze', 'prompt-en.txt');
    
    try {
      // Intentar cargar el prompt en el idioma preferido o el predeterminado
      if (request.options?.language === 'en' && fs.existsSync(promptEnPath)) {
        promptTemplate = fs.readFileSync(promptEnPath, 'utf8');
      } else if (fs.existsSync(promptPath)) {
        promptTemplate = fs.readFileSync(promptPath, 'utf8');
      } else {
        // Fallback al prompt hardcodeado si no se pueden cargar los archivos
        promptTemplate = `
        Analiza el siguiente sitio web:
        URL: {url}
        
        Proporciona:
        1. Un resumen conciso del propósito y contenido del sitio (3-5 oraciones)
        2. 3-5 insights sobre el diseño, usabilidad y contenido del sitio
        3. 2-3 recomendaciones específicas para mejorar el sitio
        
        Por favor, proporciona tu respuesta en formato JSON con la siguiente estructura:
        \`\`\`json
        {
          "summary": "Resumen del sitio aquí...",
          "insights": [
            {
              "title": "Título del insight 1",
              "description": "Descripción detallada del insight 1"
            },
            {
              "title": "Título del insight 2",
              "description": "Descripción detallada del insight 2"
            },
            {
              "title": "Título del insight 3",
              "description": "Descripción detallada del insight 3"
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
        
        Asegúrate de que tu respuesta sea un JSON válido y estructurado exactamente como se muestra arriba.
        `;
      }
      
      // Reemplazar placeholders en el prompt
      const userMessage = promptTemplate.replace('{url}', request.url);
      
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
        try {
          // Intentar parsear la respuesta como JSON
          const jsonMatch = responseContent.match(/```json\s*([\s\S]*?)\s*```/) || 
                           responseContent.match(/```\s*([\s\S]*?)\s*```/) ||
                           [null, responseContent];
          
          const jsonContent = jsonMatch[1].trim();
          const parsedResponse = JSON.parse(jsonContent);
          
          // Construir el resultado a partir del JSON
          const result: ExtendedAnalyzeResponse = {
            summary: parsedResponse.summary || 'No se proporcionó un resumen.',
            insights: parsedResponse.insights?.map((insight: any) => 
              typeof insight === 'string' ? insight : `${insight.title}: ${insight.description}`
            ) || [],
            recommendations: parsedResponse.recommendations?.map((rec: any) => ({
              issue: rec.issue || 'Problema no especificado',
              solution: rec.recommendation || 'Solución no especificada',
              priority: (rec.priority === 'alta' || rec.priority === 'high') ? 'high' : 
                       (rec.priority === 'baja' || rec.priority === 'low') ? 'low' : 'medium'
            })) || [],
            metadata: {
              analyzed_by: request.options?.provider === 'openai' ? 'GPT' : 'Claude',
              timestamp: new Date().toISOString(),
              model_used: response.model || 'unknown',
              status: 'success'
            },
            screenshot: request.screenshot,
            rawResponse: parsedResponse // Guardar la respuesta completa para uso futuro
          };
          
          console.log(`[initialAnalyzerAgent] Análisis inicial completado con éxito (formato JSON)`);
          return result;
        } catch (jsonError) {
          console.warn(`[initialAnalyzerAgent] Error al parsear JSON, usando formato de texto: ${jsonError}`);
          
          // Fallback al método anterior de extracción de texto si el JSON falla
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
            screenshot: request.screenshot
          };
          
          console.log(`[initialAnalyzerAgent] Análisis inicial completado con éxito (formato texto)`);
          return result;
        }
      } else {
        throw new Error('La respuesta de la API no tiene el formato esperado');
      }
    } catch (promptError) {
      console.error(`[initialAnalyzerAgent] Error al cargar el prompt: ${promptError}`);
      throw promptError;
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
    language?: 'en' | 'es'; // Add language option
  } = {}
): Promise<AnalyzeResponse> {
  // Construir el objeto de solicitud
  const analyzeRequest: ExtendedAnalyzeRequest = {
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