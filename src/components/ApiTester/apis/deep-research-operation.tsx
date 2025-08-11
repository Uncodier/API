import React from 'react';
import { BaseApiConfig } from '../types';

// Configuración para Deep Research Operation API
export const deepResearchOperationConfig: BaseApiConfig = {
  id: 'deep-research-operation',
  name: 'Deep Research Operation',
  description: 'Realiza búsquedas especializadas con DuckDuckGo y análisis opcional con Tavily',
  defaultEndpoint: '/api/deepResearch/operation',

  getInitialState: () => ({
    operation_type: 'llm_news',
    query: '',
    date_from: '',
    date_to: '',
    sources: [],
    keywords: [],
    max_results: 30
  }),

  renderFields: ({ state, updateState, errors }) => (
    <div className="space-y-4">
      {/* Operation Type */}
      <div>
        <label htmlFor="operation_type" className="block text-sm font-medium text-gray-700 mb-1">
          Tipo de Operación <span className="text-red-500">*</span>
        </label>
        <select
          id="operation_type"
          value={state.operation_type || 'llm_news'}
          onChange={(e) => updateState({ operation_type: e.target.value })}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="llm_news">LLM News - Noticias sobre modelos de lenguaje</option>
          <option value="general_news">General News - Búsqueda general de noticias</option>
          <option value="custom_search">Custom Search - Búsqueda personalizada</option>
        </select>
        {errors?.operation_type && (
          <p className="text-red-500 text-xs mt-1">{errors.operation_type}</p>
        )}
      </div>

      {/* Query - Conditional */}
      {(state.operation_type === 'general_news' || state.operation_type === 'custom_search') && (
        <div>
          <label htmlFor="query" className="block text-sm font-medium text-gray-700 mb-1">
            Query de Búsqueda <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            id="query"
            value={state.query || ''}
            onChange={(e) => updateState({ query: e.target.value })}
            placeholder="Ej: artificial intelligence startups funding"
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {errors?.query && (
            <p className="text-red-500 text-xs mt-1">{errors.query}</p>
          )}
        </div>
      )}

      {/* Date Range */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label htmlFor="date_from" className="block text-sm font-medium text-gray-700 mb-1">
            Fecha Desde
          </label>
          <input
            type="date"
            id="date_from"
            value={state.date_from || ''}
            onChange={(e) => updateState({ date_from: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label htmlFor="date_to" className="block text-sm font-medium text-gray-700 mb-1">
            Fecha Hasta
          </label>
          <input
            type="date"
            id="date_to"
            value={state.date_to || ''}
            onChange={(e) => updateState({ date_to: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      {/* Sources */}
      <div>
        <label htmlFor="sources" className="block text-sm font-medium text-gray-700 mb-1">
          Fuentes (separar por comas)
        </label>
        <input
          type="text"
          id="sources"
          value={Array.isArray(state.sources) ? state.sources.join(', ') : ''}
          onChange={(e) => {
            const sources = e.target.value
              .split(',')
              .map(s => s.trim())
              .filter(s => s.length > 0);
            updateState({ sources });
          }}
          placeholder="Ej: news.ycombinator.com, techcrunch.com, theverge.com"
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <p className="text-xs text-gray-500 mt-1">
          Dominios donde buscar. Para LLM News se usa automáticamente news.ycombinator.com
        </p>
      </div>

      {/* Keywords - Only for LLM News */}
      {state.operation_type === 'llm_news' && (
        <div>
          <label htmlFor="keywords" className="block text-sm font-medium text-gray-700 mb-1">
            Palabras Clave (separar por comas)
          </label>
          <input
            type="text"
            id="keywords"
            value={Array.isArray(state.keywords) ? state.keywords.join(', ') : ''}
            onChange={(e) => {
              const keywords = e.target.value
                .split(',')
                .map(s => s.trim())
                .filter(s => s.length > 0);
              updateState({ keywords });
            }}
            placeholder="Ej: ChatGPT, Claude, OpenAI, Anthropic, GPT-4"
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="text-xs text-gray-500 mt-1">
            Palabras clave adicionales para refinar la búsqueda de LLMs
          </p>
        </div>
      )}

      {/* Max Results */}
      <div>
        <label htmlFor="max_results" className="block text-sm font-medium text-gray-700 mb-1">
          Máximo de Resultados
        </label>
        <input
          type="number"
          id="max_results"
          value={state.max_results || 30}
          onChange={(e) => updateState({ max_results: parseInt(e.target.value) || 30 })}
          min="1"
          max="100"
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <p className="text-xs text-gray-500 mt-1">
          Número máximo de resultados a retornar (1-100)
        </p>
      </div>

      {/* Note about simplified output */}
      <div className="bg-green-50 p-4 rounded-md">
        <h4 className="text-sm font-medium text-green-800 mb-2">
          ✅ Salida Simplificada
        </h4>
        <p className="text-xs text-green-700">
          Esta API está optimizada para extraer únicamente <strong>URLs de noticias</strong> con metadatos básicos (título, dominio, fecha). 
          No incluye análisis de contenido para mayor velocidad y eficiencia.
        </p>
      </div>

      {/* Examples based on operation type */}
      <div className="bg-blue-50 p-4 rounded-md">
        <h4 className="text-sm font-medium text-blue-800 mb-2">
          Ejemplos para {state.operation_type}:
        </h4>
        <div className="text-xs text-blue-700 space-y-1">
          {state.operation_type === 'llm_news' && (
            <>
              <p>• Buscar noticias recientes sobre LLMs en Hacker News</p>
              <p>• Filtrar por palabras clave específicas como "ChatGPT", "Claude"</p>
              <p>• Usar rangos de fechas para encontrar tendencias temporales</p>
            </>
          )}
          {state.operation_type === 'general_news' && (
            <>
              <p>• Query: "artificial intelligence startups funding"</p>
              <p>• Fuentes: techcrunch.com, venturebeat.com</p>
              <p>• Período: últimos 6 meses</p>
            </>
          )}
          {state.operation_type === 'custom_search' && (
            <>
              <p>• Query: "machine learning breakthrough OR neural networks"</p>
              <p>• Fuente: arxiv.org para papers académicos</p>
              <p>• Extracción rápida de URLs relevantes</p>
            </>
          )}
        </div>
      </div>
    </div>
  ),

  buildRequestBody: (state) => {
    const body: any = {
      operation_type: state.operation_type || 'llm_news',
      max_results: state.max_results || 30,
      include_content_analysis: state.include_content_analysis || false,
      analysis_depth: state.analysis_depth || 'basic'
    };

    // Add query if required for operation type
    if (state.operation_type === 'general_news' || state.operation_type === 'custom_search') {
      if (state.query) {
        body.query = state.query;
      }
    }

    // Add date filters if provided
    if (state.date_from) {
      body.date_from = state.date_from;
    }
    if (state.date_to) {
      body.date_to = state.date_to;
    }

    // Add sources if provided
    if (state.sources && Array.isArray(state.sources) && state.sources.length > 0) {
      body.sources = state.sources;
    }

    // Add keywords for LLM news
    if (state.operation_type === 'llm_news' && state.keywords && Array.isArray(state.keywords) && state.keywords.length > 0) {
      body.keywords = state.keywords;
    }

    return body;
  }
};

export default deepResearchOperationConfig;
