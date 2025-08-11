/**
 * Ejemplos de uso de la API Deep Research Operation
 * 
 * Esta API permite realizar búsquedas especializadas con filtros de fecha
 * utilizando DuckDuckGo y análisis opcional de contenido con Tavily.
 */

// Ejemplo 1: Búsqueda de noticias de LLMs en Hacker News
export const llmNewsSearchExample = {
  method: 'POST',
  url: '/api/deepResearch/operation',
  body: {
    operation_type: 'llm_news',
    date_from: '2024-01-01',
    date_to: '2024-12-31',
    keywords: ['ChatGPT', 'Claude', 'OpenAI', 'Anthropic', 'GPT-4'],
    max_results: 50
  }
};

// Ejemplo 2: Búsqueda general de noticias sobre startups de IA
export const generalNewsSearchExample = {
  method: 'POST',
  url: '/api/deepResearch/operation',
  body: {
    operation_type: 'general_news',
    query: 'artificial intelligence startups funding',
    date_from: '2024-06-01',
    date_to: '2024-12-31',
    sources: ['techcrunch.com', 'venturebeat.com', 'theverge.com'],
    max_results: 30
  }
};

// Ejemplo 3: Búsqueda personalizada en un sitio específico
export const customSearchExample = {
  method: 'POST',
  url: '/api/deepResearch/operation',
  body: {
    operation_type: 'custom_search',
    query: 'machine learning breakthrough OR neural networks advancement',
    date_from: '2024-09-01',
    date_to: '2024-12-31',
    sources: ['arxiv.org'],
    max_results: 20
  }
};

// Ejemplo 4: Búsqueda rápida de tendencias recientes
export const recentTrendsExample = {
  method: 'POST',
  url: '/api/deepResearch/operation',
  body: {
    operation_type: 'llm_news',
    date_from: '2024-12-01', // Último mes
    date_to: '2024-12-31',
    keywords: ['AGI', 'multimodal', 'reasoning'],
    max_results: 25
  }
};

// Función de prueba que puedes usar en un script
export async function testDeepResearchAPI() {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  
  try {
    console.log('🧪 Testing Deep Research Operation API...');
    
    // Prueba 1: LLM News Search
    console.log('\n📰 Testing LLM News Search...');
    const response1 = await fetch(`${baseUrl}/api/deepResearch/operation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(llmNewsSearchExample.body)
    });
    
    const result1 = await response1.json();
    console.log('LLM News Results:', {
      success: result1.success,
      total_results: result1.total_results,
      processing_time: result1.processing_time_ms + 'ms',
      sample_title: result1.results?.[0]?.title
    });
    
    // Prueba 2: General News Search
    console.log('\n🌐 Testing General News Search...');
    const response2 = await fetch(`${baseUrl}/api/deepResearch/operation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(generalNewsSearchExample.body)
    });
    
    const result2 = await response2.json();
    console.log('General News Results:', {
      success: result2.success,
      total_results: result2.total_results,
      processing_time: result2.processing_time_ms + 'ms',
      sample_title: result2.results?.[0]?.title
    });
    
    return {
      llm_news: result1,
      general_news: result2
    };
    
  } catch (error) {
    console.error('❌ Test failed:', error);
    throw error;
  }
}

// Respuesta de ejemplo que esperar de la API
export const exampleResponse = {
  "success": true,
  "operation_type": "llm_news",
  "query": "LLM and AI news",
  "date_range": {
    "from": "2024-01-01",
    "to": "2024-12-31"
  },
  "results": [
    {
      "title": "ChatGPT-4 Shows Remarkable Improvements in Mathematical Reasoning",
      "url": "https://news.ycombinator.com/item?id=38234567",
      "domain": "news.ycombinator.com",
      "publishedDate": "2024-03-15"
    }
  ],
  "total_results": 25,
  "processing_time_ms": 1200
};

// Casos de uso recomendados
export const useCases = {
  "competitive_intelligence": {
    description: "Monitorear noticias sobre competidores en el espacio de IA",
    example: {
      operation_type: "general_news",
      query: "OpenAI OR Anthropic OR Google AI OR Microsoft AI",
      date_from: "2024-10-01",
      sources: ["techcrunch.com", "theverge.com", "arstechnica.com"]
    }
  },
  
  "research_trends": {
    description: "Identificar tendencias emergentes en investigación de LLMs",
    example: {
      operation_type: "custom_search",
      query: "multimodal AI OR vision language models OR reasoning",
      sources: ["arxiv.org", "paperswithcode.com"]
    }
  },
  
  "market_analysis": {
    description: "Analizar el mercado y inversiones en IA",
    example: {
      operation_type: "general_news",
      query: "AI startup funding OR artificial intelligence investment",
      sources: ["crunchbase.com", "venturebeat.com"],
      date_from: "2024-01-01"
    }
  },
  
  "technology_updates": {
    description: "Mantenerse actualizado sobre nuevos lanzamientos",
    example: {
      operation_type: "llm_news",
      keywords: ["model release", "API update", "new features"]
    }
  }
};

// Tips para uso óptimo
export const optimizationTips = {
  "date_ranges": {
    tip: "Usar rangos de fechas específicos mejora la calidad de los resultados",
    examples: [
      "Para noticias recientes: últimos 30 días",
      "Para análisis trimestral: 3 meses específicos",
      "Para análisis anual: año completo"
    ]
  },
  
  "keyword_selection": {
    tip: "Combinar términos generales y específicos",
    examples: [
      "General: 'AI', 'machine learning'",
      "Específico: 'ChatGPT-4', 'Claude-3', 'GPT-4-Turbo'"
    ]
  },
  
  "performance": {
    tip: "Optimizado para velocidad - solo extrae URLs con metadatos básicos",
    note: "Sin análisis de contenido para respuestas ultra-rápidas (1-3 segundos típicamente)"
  }
};
