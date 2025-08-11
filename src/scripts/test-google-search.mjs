#!/usr/bin/env node

/**
 * Script de prueba rápido para Google Search Service
 * 
 * Uso:
 *   node src/scripts/test-google-search.mjs
 */

console.log('🧪 Testing Google Search Integration...');

// Verificar variables de entorno
const hasGoogleAPI = (process.env.GOOGLE_CLOUD_API_KEY || process.env.GOOGLE_API_KEY) && process.env.GOOGLE_CSE_ID;
const hasSerpAPI = process.env.SERPAPI_KEY;
const hasTavily = process.env.TAVILY_API_KEY;

console.log('\n📋 Configuración detectada:');
console.log(`🔍 Google Custom Search API: ${hasGoogleAPI ? '✅ Configurado' : '❌ No configurado'}`);
console.log(`🐍 SerpAPI: ${hasSerpAPI ? '✅ Configurado' : '❌ No configurado'}`);
console.log(`🔄 Tavily (fallback): ${hasTavily ? '✅ Configurado' : '❌ No configurado'}`);

if (!hasGoogleAPI && !hasSerpAPI && !hasTavily) {
  console.error('\n❌ Ninguna API está configurada. Por favor configura al menos una:');
  console.log('\nGoogle Custom Search API (Recomendado):');
  console.log('GOOGLE_CLOUD_API_KEY=your_api_key');
  console.log('GOOGLE_CSE_ID=your_cse_id');
  console.log('\nO SerpAPI:');
  console.log('SERPAPI_KEY=your_serpapi_key');
  console.log('\nO Tavily (ya configurado probablemente):');
  console.log('TAVILY_API_KEY=your_tavily_key');
  process.exit(1);
}

// Ejemplo de request que se puede hacer a la API
const exampleRequest = {
  operation_type: 'llm_news',
  date_from: '2024-12-01',
  date_to: '2024-12-31',
  keywords: ['ChatGPT', 'Claude'],
  max_results: 10
};

console.log('\n📝 Ejemplo de request que puedes hacer:');
console.log('POST /api/deepResearch/operation');
console.log(JSON.stringify(exampleRequest, null, 2));

console.log('\n🔧 La API ahora usará:');
if (hasGoogleAPI) {
  console.log('1. 🎯 Google Custom Search API (principal)');
  if (hasSerpAPI) console.log('2. 🐍 SerpAPI (alternativa)');
  if (hasTavily) console.log('3. 🔄 Tavily (fallback)');
} else if (hasSerpAPI) {
  console.log('1. 🐍 SerpAPI (principal)');
  if (hasTavily) console.log('2. 🔄 Tavily (fallback)');
} else {
  console.log('1. 🔄 Tavily (único método disponible)');
}

console.log('\n✅ Configuración válida. La API está lista para usar!');
console.log('\n💡 Tip: Para mejores resultados, configura Google Custom Search API.');
console.log('   Es gratuito hasta 100 búsquedas/día y muy confiable.');

console.log('\n🔗 Enlaces útiles:');
console.log('- Google Cloud Console: https://console.cloud.google.com/');
console.log('- Custom Search Engine: https://programmablesearchengine.google.com/');
console.log('- SerpAPI: https://serpapi.com/');
