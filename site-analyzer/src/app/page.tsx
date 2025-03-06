"use client"

import { useState, useEffect } from 'react'
import dynamic from 'next/dynamic'
import { toast } from 'react-hot-toast'
import { AVAILABLE_MODELS, AVAILABLE_PROVIDERS } from '@/lib/config/analyzer-config'

// Importamos dinámicamente el componente StructuredAnalysis para evitar problemas con SSR
const StructuredAnalysis = dynamic(
  () => import('./components/StructuredAnalysis'),
  { ssr: false }
)

export default function Home() {
  const [url, setUrl] = useState('https://example.com')
  const [analysisType, setAnalysisType] = useState<'basic' | 'detailed' | 'structured'>('basic')
  const [includeScreenshot, setIncludeScreenshot] = useState(true)
  const [provider, setProvider] = useState<'anthropic' | 'openai' | 'gemini'>('anthropic')
  const [modelId, setModelId] = useState('')
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<any>(null)
  const [llmResponse, setLlmResponse] = useState<any>(null)
  const [structuredData, setStructuredData] = useState<any>(null)
  const [activeTab, setActiveTab] = useState('basic')
  const [completedRecommendations, setCompletedRecommendations] = useState<Record<string, boolean>>({})
  const [originalResponse, setOriginalResponse] = useState<any>(null)
  const [isStructuredAnalyzing, setIsStructuredAnalyzing] = useState(false)
  const [isLlmAnalyzing, setIsLlmAnalyzing] = useState(false)
  
  // Efecto para actualizar el modelId cuando cambia el proveedor
  useEffect(() => {
    if (provider && AVAILABLE_MODELS[provider] && AVAILABLE_MODELS[provider].length > 0) {
      setModelId(AVAILABLE_MODELS[provider][0].id);
    }
  }, [provider])
  
  // Efecto para logear el estado de llmResponse cuando cambia
  useEffect(() => {
    if (llmResponse) {
      console.log('LLM Response actualizada:', llmResponse);
      console.log('¿Tiene summary?', Boolean(llmResponse.summary || (llmResponse.result && llmResponse.result.summary)));
      console.log('¿Tiene insights?', Boolean((llmResponse.insights && llmResponse.insights.length) || 
                                             (llmResponse.result && llmResponse.result.insights && llmResponse.result.insights.length)));
      console.log('¿Tiene recommendations?', Boolean((llmResponse.recommendations && llmResponse.recommendations.length) || 
                                                   (llmResponse.result && llmResponse.result.recommendations && llmResponse.result.recommendations.length)));
    }
  }, [llmResponse]);

  // Función para marcar una recomendación como completada
  const markAsDone = (index: number) => {
    setCompletedRecommendations(prev => ({
      ...prev,
      [index.toString()]: true
    }));
    
    // Si hay una integración con backend, aquí podríamos enviar la actualización
    console.log(`Recomendación ${index} marcada como completada`);
    
    // También podríamos actualizar el estado de la recomendación en llmResponse
    if (llmResponse && typeof llmResponse === 'object') {
      try {
        // Crear una copia profunda del objeto llmResponse
        const updatedResponse = JSON.parse(JSON.stringify(llmResponse));
        
        // Actualizar el estado de la recomendación
        if (Array.isArray(updatedResponse.recommendations) && updatedResponse.recommendations[index]) {
          updatedResponse.recommendations[index].status = 'done';
          setLlmResponse(updatedResponse);
        } else if (updatedResponse.result && 
                  Array.isArray(updatedResponse.result.recommendations) && 
                  updatedResponse.result.recommendations[index]) {
          updatedResponse.result.recommendations[index].status = 'done';
          setLlmResponse(updatedResponse);
        }
      } catch (error) {
        console.error('Error al actualizar el estado de la recomendación:', error);
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsAnalyzing(true)
    setError(null)
    setResult(null)
    setLlmResponse(null)
    setStructuredData(null)
    setCompletedRecommendations({})

    try {
      console.log(`Iniciando análisis para URL: ${url}`);
      console.log(`Tipo de análisis: ${analysisType}`);
      console.log(`Incluir captura: ${includeScreenshot}`);
      console.log(`Proveedor: ${provider}`);
      console.log(`Modelo: ${modelId}`);
      
      // Set active tab based on analysis type
      if (analysisType === 'structured') {
        setActiveTab('structured')
        console.log('Estableciendo pestaña activa: structured');
      } else {
        setActiveTab('basic')
        console.log('Estableciendo pestaña activa: basic');
      }
      
      // Preparar los datos para la API
      const requestData = { 
        url,
        options: {
          analysisType,
          depth: 2,
          timeout: 30000,
          includeScreenshot,
          provider,
          modelId
        }
      };
      
      console.log('Datos de la solicitud:', JSON.stringify(requestData));
      
      // Call the API with the selected analysis type and options
      const response = await fetch('/api/site/analyze', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestData),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.message || 'Error analizando el sitio')
      }

      const data = await response.json()
      console.log('Respuesta de la API recibida:', data);
      
      if (data.error) {
        throw new Error(data.error)
      }

      // Procesar la respuesta según el tipo de análisis
      if (data.analysisType === 'structured') {
        console.log('Procesando respuesta de análisis estructurado');
        
        // Verificar la estructura de los datos
        if (data.result) {
          console.log('Estructura de datos recibida:', Object.keys(data.result));
          
          // Verificar si tenemos datos estructurados directamente o dentro de structuredAnalysis
          if (data.result.structuredAnalysis) {
            console.log('Datos encontrados en result.structuredAnalysis');
            console.log('Número de bloques:', data.result.structuredAnalysis.blocks?.length || 0);
            setStructuredData(data.result);
          } else if (data.result.site_info && data.result.blocks) {
            console.log('Datos estructurados encontrados directamente en result');
            console.log('Número de bloques:', data.result.blocks?.length || 0);
            setStructuredData(data.result);
          } else {
            console.warn('Estructura de datos no reconocida en análisis estructurado');
            setStructuredData(data.result);
          }
        } else {
          console.warn('No se encontraron datos en la respuesta');
          setStructuredData(data);
        }
      } else {
        console.log('Procesando respuesta de análisis básico/detallado');
        
        // Verificar la estructura de los datos
        if (data.result) {
          console.log('Estructura de datos recibida para análisis básico/detallado:', 
                     typeof data.result === 'object' ? Object.keys(data.result) : typeof data.result);
          
          // Verificar si tenemos los datos esperados en formato objeto
          if (typeof data.result === 'object' && data.result !== null && 
              (data.result.summary || data.result.insights || data.result.recommendations)) {
            console.log('Datos de análisis básico/detallado encontrados en formato objeto');
            setLlmResponse(data.result);
          } 
          // Verificar si tenemos texto plano
          else if (typeof data.result === 'string') {
            console.log('Datos de análisis básico/detallado encontrados en formato texto');
            
            // Extraer las secciones de la respuesta de texto
            const summaryMatch = data.result.match(/(?:Análisis|Analysis):(.*?)(?:\n\n|\n(?=Insights|Fortalezas|Debilidades|Strengths|Weaknesses|Recomendaciones|Recommendations))/i);
            const insightsMatch = data.result.match(/(?:Insights|Fortalezas y debilidades|Strengths and weaknesses):(.*?)(?:\n\n|\n(?=Recomendaciones|Recommendations))/i);
            const recommendationsMatch = data.result.match(/(?:Recomendaciones|Recommendations):(.*)/i);
            
            // Extraer y formatear el resumen
            const summary = summaryMatch 
              ? summaryMatch[1].trim() 
              : data.result; // Si no hay formato, usar todo el texto como resumen
            
            // Extraer y formatear los insights
            let insights: string[] = [];
            if (insightsMatch) {
              insights = insightsMatch[1]
                .split(/\n-|\n\d+\./)
                .map((item: string) => item.trim())
                .filter((item: string) => item.length > 0);
            } else if (!summaryMatch && !recommendationsMatch) {
              // Si no hay formato específico, intentar dividir el texto en párrafos para los insights
              const paragraphs = data.result.split(/\n\n+/);
              if (paragraphs.length > 1) {
                // Usar el primer párrafo como resumen y el resto como insights
                insights = paragraphs.slice(1).map((p: string) => p.trim()).filter((p: string) => p.length > 0);
              }
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
            } else if (!summaryMatch && !insightsMatch && data.result.includes('\n')) {
              // Si no hay formato específico pero hay saltos de línea, intentar extraer recomendaciones
              const lines = data.result.split('\n').filter((line: string) => line.trim().length > 0);
              if (lines.length > 1) {
                recommendations = lines.slice(-Math.min(3, lines.length)).map((line: string) => ({
                  issue: line.trim(),
                  solution: 'Extraído automáticamente del texto',
                  priority: 'medium' as const
                }));
              }
            }
            
            // Construir un objeto estructurado a partir del texto
            const structuredResponse = {
              summary,
              insights,
              recommendations,
              metadata: {
                analyzed_by: data.analysisType === 'detailed' ? 'Claude (Detallado)' : 'Claude (Básico)',
                timestamp: new Date().toISOString(),
                model_used: data.result.model_used || 'unknown',
                status: 'success'
              }
            };
            
            console.log('Respuesta estructurada creada a partir del texto:', structuredResponse);
            setLlmResponse(structuredResponse);
          }
          else {
            console.warn('Estructura de datos no reconocida en análisis básico/detallado');
            // Intentar adaptar la estructura si es posible
            const adaptedResponse = {
              summary: typeof data.result === 'object' && data.result !== null && typeof data.result.summary === 'string' 
                      ? data.result.summary 
                      : (typeof data.result === 'string' ? data.result : 'No hay resumen disponible'),
              insights: typeof data.result === 'object' && data.result !== null && Array.isArray(data.result.insights) 
                      ? data.result.insights 
                      : [],
              recommendations: typeof data.result === 'object' && data.result !== null && Array.isArray(data.result.recommendations) 
                             ? data.result.recommendations 
                             : [],
              metadata: typeof data.result === 'object' && data.result !== null && data.result.metadata 
                      ? data.result.metadata 
                      : {
                          analyzed_by: data.analysisType === 'detailed' ? 'Claude (Detallado)' : 'Claude (Básico)',
                          timestamp: new Date().toISOString(),
                          model_used: 'unknown',
                          status: 'success'
                        }
            };
            console.log('Datos adaptados:', adaptedResponse);
            setLlmResponse(adaptedResponse);
          }
        } else {
          console.warn('No se encontraron datos en la respuesta para análisis básico/detallado');
          // Crear una respuesta básica
          const basicResponse = {
            summary: 'No se pudo obtener un resumen del análisis.',
            insights: [],
            recommendations: [],
            metadata: {
              analyzed_by: data.analysisType === 'detailed' ? 'Claude (Detallado)' : 'Claude (Básico)',
              timestamp: new Date().toISOString(),
              model_used: 'unknown',
              status: 'error'
            }
          };
          setLlmResponse(basicResponse);
        }
      }

      setResult(data.result)
      setOriginalResponse(data.result)
      setIsAnalyzing(false)
    } catch (error: any) {
      console.error('Error analyzing site:', error)
      setIsAnalyzing(false)
      setError(error.message || 'No se pudo analizar el sitio')
      toast.error(`Error: ${error.message || 'No se pudo analizar el sitio'}`)
    }
  }

  // Función simple para mostrar notificaciones en lugar de toast
  const showNotification = (message: string, isError = false) => {
    console.log(isError ? `Error: ${message}` : message);
    alert(message);
  };

  return (
    <main className="min-h-screen p-8">
      <div className="max-w-5xl mx-auto">
        <h1 className="text-3xl font-bold mb-6">Site Analyzer</h1>
        
        <form onSubmit={handleSubmit} className="mb-8">
          <div className="flex flex-col gap-4">
            <div className="flex gap-2">
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com"
                required
                className="flex-1 px-4 py-2 border rounded-md"
              />
              <button
                type="submit"
                disabled={isAnalyzing}
                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
              >
                {isAnalyzing ? 'Analizando...' : 'Analizar'}
              </button>
            </div>
            
            <div className="flex flex-wrap gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Tipo de análisis:</label>
                <div className="flex gap-3">
                  <label className="inline-flex items-center cursor-pointer">
                    <input
                      type="radio"
                      name="analysisType"
                      value="basic"
                      checked={analysisType === 'basic'}
                      onChange={() => {
                        console.log('Seleccionando análisis básico');
                        setAnalysisType('basic');
                      }}
                      className="mr-1 cursor-pointer"
                    />
                    <span>Básico</span>
                  </label>
                  <label className="inline-flex items-center cursor-pointer">
                    <input
                      type="radio"
                      name="analysisType"
                      value="detailed"
                      checked={analysisType === 'detailed'}
                      onChange={() => {
                        console.log('Seleccionando análisis detallado');
                        setAnalysisType('detailed');
                      }}
                      className="mr-1 cursor-pointer"
                    />
                    <span>Detallado</span>
                  </label>
                  <label className="inline-flex items-center cursor-pointer">
                    <input
                      type="radio"
                      name="analysisType"
                      value="structured"
                      checked={analysisType === 'structured'}
                      onChange={() => {
                        console.log('Seleccionando análisis estructurado');
                        setAnalysisType('structured');
                      }}
                      className="mr-1 cursor-pointer"
                    />
                    <span>Estructurado</span>
                  </label>
                </div>
              </div>
              
              <div>
                <label className="block text-sm font-medium mb-1">Opciones:</label>
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    id="includeScreenshot"
                    name="includeScreenshot"
                    checked={includeScreenshot}
                    onChange={(e) => {
                      const newValue = e.target.checked;
                      console.log(`Cambiando includeScreenshot a: ${newValue}`);
                      setIncludeScreenshot(newValue);
                    }}
                    className="mr-1 cursor-pointer"
                  />
                  <label htmlFor="includeScreenshot" className="cursor-pointer">
                    Incluir captura de pantalla
                  </label>
                </div>
              </div>
              
              <div className="w-full md:w-auto">
                <label className="block text-sm font-medium mb-1">Proveedor de IA:</label>
                <select
                  value={provider}
                  onChange={(e) => setProvider(e.target.value as 'anthropic' | 'openai' | 'gemini')}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                >
                  {AVAILABLE_PROVIDERS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              
              <div className="w-full md:w-auto">
                <label className="block text-sm font-medium mb-1">Modelo:</label>
                <select
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                >
                  {AVAILABLE_MODELS[provider].map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        </form>
        
        {error && (
          <div className="mb-8 p-4 bg-red-100 border border-red-400 text-red-700 rounded">
            {error}
          </div>
        )}

        {isAnalyzing && (
          <div className="p-4 bg-blue-100 border border-blue-300 rounded-md mb-6">
            <p className="text-blue-700">Analizando sitio, por favor espere...</p>
          </div>
        )}

        {(result || llmResponse || structuredData) && (
          <div className="mt-8">
            <div className="mb-6 border-b border-gray-200">
              <div className="flex">
                <button
                  onClick={() => setActiveTab('basic')}
                  className={`px-6 py-2 border-b-2 ${
                    activeTab === 'basic'
                      ? 'border-blue-500 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                  disabled={!llmResponse}
                >
                  Análisis Básico/Detallado
                </button>
                <button
                  onClick={() => setActiveTab('structured')}
                  className={`px-6 py-2 border-b-2 ${
                    activeTab === 'structured'
                      ? 'border-blue-500 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                  disabled={!structuredData}
                >
                  Análisis Estructurado
                </button>
              </div>
            </div>

            <div>
              {activeTab === 'basic' && llmResponse && (
                <div>
                  <div className="flex justify-between items-center mb-4">
                    <h3 className="text-lg font-semibold">Análisis {analysisType === 'detailed' ? 'Detallado' : 'Básico'}</h3>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleSubmit(new Event('click') as any)}
                        className="px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 text-sm flex items-center"
                        disabled={isAnalyzing}
                      >
                        {isAnalyzing ? (
                          <>
                            <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                            </svg>
                            Analizando...
                          </>
                        ) : (
                          <>
                            <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
                            </svg>
                            Reanalizar
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                  <div className="bg-white p-6 rounded-lg shadow mb-6">
                    <h2 className="text-2xl font-semibold mb-4">Resumen del análisis</h2>
                    <p className="mb-4">
                      {typeof llmResponse === 'object' && llmResponse !== null
                        ? (llmResponse.summary || 
                           (llmResponse.result && llmResponse.result.summary) || 
                           'No hay resumen disponible')
                        : 'No hay resumen disponible'}
                    </p>
                    
                    {/* Insights section */}
                    {(
                      (typeof llmResponse === 'object' && llmResponse !== null && 
                       ((llmResponse.insights && Array.isArray(llmResponse.insights) && llmResponse.insights.length > 0) || 
                        (llmResponse.result && llmResponse.result.insights && Array.isArray(llmResponse.result.insights) && llmResponse.result.insights.length > 0)))
                    ) && (
                      <div className="mb-6">
                        <h3 className="text-lg font-medium mb-2">Insights</h3>
                        <div className="space-y-2">
                          {(
                            (typeof llmResponse === 'object' && llmResponse !== null && 
                             (Array.isArray(llmResponse.insights) ? llmResponse.insights : 
                              (llmResponse.result && Array.isArray(llmResponse.result.insights) ? llmResponse.result.insights : [])))
                          ).map((insight: string, index: number) => (
                            <p key={index} className="text-gray-700">{insight}</p>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Recommendations section */}
                    {(
                      (typeof llmResponse === 'object' && llmResponse !== null && 
                       ((llmResponse.recommendations && Array.isArray(llmResponse.recommendations) && llmResponse.recommendations.length > 0) || 
                        (llmResponse.result && llmResponse.result.recommendations && Array.isArray(llmResponse.result.recommendations) && llmResponse.result.recommendations.length > 0)))
                    ) && (
                      <div className="mb-6">
                        <h3 className="text-lg font-medium mb-2">Recomendaciones</h3>
                        <ul className="space-y-3">
                          {(
                            (typeof llmResponse === 'object' && llmResponse !== null && 
                             (Array.isArray(llmResponse.recommendations) ? llmResponse.recommendations : 
                              (llmResponse.result && Array.isArray(llmResponse.result.recommendations) ? llmResponse.result.recommendations : [])))
                          ).map((rec: any, index: number) => (
                            <li key={index} className={`p-3 ${completedRecommendations[index.toString()] ? 'bg-green-50' : 'bg-gray-50'} rounded border`}>
                              <div className="flex justify-between">
                                <span className={`font-medium ${completedRecommendations[index.toString()] ? 'line-through text-gray-500' : ''}`}>
                                  {rec.issue}
                                </span>
                                <div className="flex items-center gap-2">
                                  <span className={`text-sm px-2 py-1 rounded ${
                                    rec.priority === 'high' ? 'bg-red-100 text-red-800' : 
                                    rec.priority === 'medium' ? 'bg-yellow-100 text-yellow-800' : 
                                    'bg-green-100 text-green-800'
                                  }`}>
                                    {rec.priority === 'high' ? 'Alta' : 
                                    rec.priority === 'medium' ? 'Media' : 'Baja'} prioridad
                                  </span>
                                  {rec.status === 'done' || completedRecommendations[index.toString()] ? (
                                    <span className="text-sm bg-green-100 text-green-800 px-2 py-1 rounded">Completado</span>
                                  ) : (
                                    <button 
                                      onClick={() => markAsDone(index)}
                                      className="text-sm bg-blue-100 text-blue-800 px-2 py-1 rounded hover:bg-blue-200"
                                    >
                                      Marcar como completado
                                    </button>
                                  )}
                                </div>
                              </div>
                              <p className={`mt-1 text-sm ${completedRecommendations[index.toString()] ? 'text-gray-500' : 'text-gray-700'}`}>
                                {rec.solution}
                              </p>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <div className="mt-4 p-3 bg-gray-100 rounded text-xs">
                      <p>Metadata: {typeof llmResponse === 'object' && llmResponse !== null ? 
                        JSON.stringify((llmResponse.metadata || (llmResponse.result && llmResponse.result.metadata)), null, 2) : 
                        'No hay metadata disponible'}</p>
                    </div>
                    
                    {/* Debug section */}
                    <div className="mt-4 p-3 bg-gray-100 rounded">
                      <details className="text-sm">
                        <summary className="cursor-pointer text-blue-500 font-medium">Debug Information</summary>
                        <div className="mt-2">
                          <h4 className="font-medium">Respuesta Original:</h4>
                          <pre className="mt-2 p-2 bg-gray-200 rounded overflow-auto max-h-96 text-xs">
                            {JSON.stringify(originalResponse, null, 2)}
                          </pre>
                        </div>
                      </details>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'structured' && structuredData && (
                <div>
                  <div className="flex justify-between items-center mb-4">
                    <h3 className="text-lg font-semibold">Análisis Estructurado</h3>
                    <button
                      onClick={() => handleSubmit(new Event('click') as any)}
                      className="px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 text-sm flex items-center"
                      disabled={isAnalyzing}
                    >
                      {isAnalyzing ? (
                        <>
                          <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                          </svg>
                          Analizando...
                        </>
                      ) : (
                        <>
                          <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
                          </svg>
                          Reanalizar
                        </>
                      )}
                    </button>
                  </div>
                  <StructuredAnalysis 
                    analysisData={
                      structuredData.structuredAnalysis ? 
                      structuredData.structuredAnalysis : 
                      structuredData
                    } 
                  />
                  <div className="mt-4 p-4 bg-gray-50 rounded-md">
                    <details className="text-sm">
                      <summary className="cursor-pointer text-blue-500 font-medium">Debug Information</summary>
                      <div className="mt-2">
                        <h4 className="font-medium">Data Structure:</h4>
                        <pre className="mt-2 p-2 bg-gray-100 rounded overflow-auto max-h-96 text-xs">
                          {JSON.stringify(structuredData, null, 2)}
                        </pre>
                      </div>
                    </details>
                  </div>
                </div>
              )}

              {/* Mensaje para guiar al usuario a cambiar al tipo de análisis correspondiente */}
              {activeTab === 'basic' && !llmResponse && (
                <div className="p-4 bg-yellow-100 border border-yellow-300 rounded-md">
                  <p className="text-yellow-700">Por favor, realiza un análisis de tipo Básico o Detallado para ver esta información.</p>
                </div>
              )}

              {activeTab === 'structured' && !structuredData && (
                <div className="p-4 bg-yellow-100 border border-yellow-300 rounded-md">
                  <p className="text-yellow-700">Por favor, realiza un análisis de tipo Estructurado para ver esta información.</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  )
} 