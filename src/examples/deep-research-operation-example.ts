/**
 * Ejemplos de investigación con Azure Bing web search
 * 
 * El endpoint activo es /api/agents/tools/webSearch. Estos ejemplos sustituyen
 * los antiguos de /api/deepResearch/operation; no usan filtros de fecha estrictos.
 * El servidor llama HTTP /openai/v1/responses con store:false y un deployment
 * existente con razonamiento y web_search_call.results (gpt-5.2 probado).
 * Credenciales: AZURE_OPENAI_SEARCH_ENDPOINT + AZURE_OPENAI_SEARCH_API_KEY,
 * opcionales; si una está configurada, ambas son obligatorias. Si no, usar
 * MICROSOFT_AZURE_OPENAI_ENDPOINT + MICROSOFT_AZURE_OPENAI_API_KEY si una está
 * configurada (ambas obligatorias); si no, AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY.
 * No mezclar pares ni recurrir al siguiente si un par está incompleto.
 * Deployment: AZURE_OPENAI_SEARCH_DEPLOYMENT, si no MICROSOFT_AZURE_OPENAI_DEPLOYMENT,
 * si no AZURE_OPENAI_DEPLOYMENT. Configurar secretos del servidor en Vercel;
 * estos ejemplos no editan .env ni despliegan y no contienen credenciales.
 * Presupuestos: basic=1 llamada/razonamiento low (por defecto), advanced=2/medium,
 * comprehensive=3/medium. No garantizan profundidad equivalente a Tavily.
 * max_results es un límite local hasta 20. include_images:true, contenido crudo
 * y filtros de fecha estrictos no se soportan y se rechazan. No se inventa score.
 * Créditos comerciales: 0.1/consulta; coste Azure: tokens + Bing num_requests.
 * Datos indexados/cacheados, no scraping en vivo. Bing es un límite de cumplimiento
 * separado: revisar sus términos y tratamiento de datos; store:false no garantiza
 * retención, residencia ni equivalencia de cumplimiento con el procesamiento Azure.
 */

// Ejemplo 1: Búsqueda de noticias de LLMs en Hacker News
export const llmNewsSearchExample = {
  method: 'POST',
  url: '/api/agents/tools/webSearch',
  body: {
    query: 'ChatGPT Claude OpenAI Anthropic language model news',
    include_domains: ['news.ycombinator.com'],
    search_depth: 'basic',
    max_results: 10,
    include_answer: true
  }
};

// Ejemplo 2: Búsqueda general de noticias sobre startups de IA
export const generalNewsSearchExample = {
  method: 'POST',
  url: '/api/agents/tools/webSearch',
  body: {
    query: 'artificial intelligence startups funding',
    include_domains: ['techcrunch.com', 'venturebeat.com', 'theverge.com'],
    search_depth: 'advanced',
    max_results: 20,
    include_answer: true
  }
};

// Ejemplo 3: Búsqueda personalizada en un sitio específico
export const customSearchExample = {
  method: 'POST',
  url: '/api/agents/tools/webSearch',
  body: {
    query: 'machine learning breakthrough OR neural networks advancement',
    include_domains: ['arxiv.org'],
    search_depth: 'comprehensive',
    max_results: 20,
    include_answer: true
  }
};

// Ejemplo 4: Tendencias recientes como intención de consulta, no filtro de fecha
export const recentTrendsExample = {
  method: 'POST',
  url: '/api/agents/tools/webSearch',
  body: {
    query: 'recent AGI multimodal reasoning research trends',
    search_depth: 'basic',
    max_results: 10,
    include_images: false
  }
};

// Prueba en vivo opcional: requiere servidor configurado y genera coste de proveedor.
export async function testDeepResearchAPI() {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  
  try {
    console.log('🧪 Testing Azure Bing webSearch API...');
    
    // Prueba 1: LLM News Search
    console.log('\n📰 Testing LLM News Search...');
    const response1 = await fetch(`${baseUrl}${llmNewsSearchExample.url}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(llmNewsSearchExample.body)
    });
    
    const result1 = await response1.json();
    console.log('LLM News Results:', {
      success: result1.success,
      total_results: result1.data?.results?.length,
      sample_title: result1.data?.results?.[0]?.title
    });
    
    // Prueba 2: General News Search
    console.log('\n🌐 Testing General News Search...');
    const response2 = await fetch(`${baseUrl}${generalNewsSearchExample.url}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(generalNewsSearchExample.body)
    });
    
    const result2 = await response2.json();
    console.log('General News Results:', {
      success: result2.success,
      total_results: result2.data?.results?.length,
      sample_title: result2.data?.results?.[0]?.title
    });
    
    return {
      llm_news: result1,
      general_news: result2
    };
    
  } catch (error) {
    console.error('❌ Web search test failed; inspect redacted server diagnostics.');
    throw error;
  }
}

// Respuesta ilustrativa, no resultado real ni garantía de número de resultados.
// No se fabrican fechas de publicación, contenido crudo ni scores de relevancia.
export const exampleResponse = {
  "success": true,
  "data": {
    "query": "LLM and AI news",
    "answer": "Illustrative research summary; verify the cited sources.",
    "results": [
      {
        "title": "Illustrative language model research article",
        "url": "https://example.invalid/research",
        "content": "Illustrative search snippet, not the raw article."
      }
    ]
  }
};

// Casos de uso recomendados
export const useCases = {
  "competitive_intelligence": {
    description: "Monitorear noticias sobre competidores en el espacio de IA",
    example: {
      query: "OpenAI OR Anthropic OR Google AI OR Microsoft AI",
      include_domains: ["techcrunch.com", "theverge.com", "arstechnica.com"],
      search_depth: "advanced",
      max_results: 20
    }
  },
  
  "research_trends": {
    description: "Identificar tendencias emergentes en investigación de LLMs",
    example: {
      query: "multimodal AI OR vision language models OR reasoning",
      include_domains: ["arxiv.org", "paperswithcode.com"],
      search_depth: "comprehensive",
      max_results: 20
    }
  },
  
  "market_analysis": {
    description: "Analizar el mercado y inversiones en IA",
    example: {
      query: "AI startup funding OR artificial intelligence investment",
      include_domains: ["crunchbase.com", "venturebeat.com"],
      max_results: 10
    }
  },
  
  "technology_updates": {
    description: "Mantenerse actualizado sobre nuevos lanzamientos",
    example: {
      query: "language model release API update new features",
      search_depth: "basic",
      max_results: 10
    }
  }
};

// Tips para uso óptimo
export const optimizationTips = {
  "date_ranges": {
    tip: "Los filtros de fecha estrictos no se soportan y se rechazan",
    examples: [
      "No enviar date_from, date_to ni time_range",
      "Mencionar un período en la consulta solo expresa intención, no garantiza filtrado",
      "Verificar fechas en las fuentes; no asumir datos en vivo"
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
    tip: "Usar basic para hasta 1 llamada web y limitar max_results a 1-20",
    note: "La latencia y el número de resultados varían; no se garantiza profundidad equivalente a Tavily"
  }
};
