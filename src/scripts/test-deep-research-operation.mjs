#!/usr/bin/env node

/**
 * Script de prueba para Deep Research Operation API
 * 
 * Uso:
 *   node src/scripts/test-deep-research-operation.mjs
 *   
 * O con argumentos específicos:
 *   node src/scripts/test-deep-research-operation.mjs --type=llm_news --days=30
 */

import fetch from 'node-fetch';

// Configuración
const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
const API_ENDPOINT = `${BASE_URL}/api/deepResearch/operation`;

// Función para obtener fechas
function getDateRange(days = 30) {
  const today = new Date();
  const pastDate = new Date();
  pastDate.setDate(today.getDate() - days);
  
  return {
    from: pastDate.toISOString().split('T')[0],
    to: today.toISOString().split('T')[0]
  };
}

// Ejemplos de requests
const examples = {
  llm_news: (days = 30) => {
    const { from, to } = getDateRange(days);
    return {
      operation_type: 'llm_news',
      date_from: from,
      date_to: to,
      keywords: ['ChatGPT', 'Claude', 'OpenAI', 'Anthropic', 'GPT-4'],
      max_results: 25
    };
  },
  
  general_news: (days = 30) => {
    const { from, to } = getDateRange(days);
    return {
      operation_type: 'general_news',
      query: 'artificial intelligence startups funding',
      date_from: from,
      date_to: to,
      sources: ['techcrunch.com', 'venturebeat.com'],
      max_results: 20
    };
  },
  
  custom_search: (days = 30) => {
    const { from, to } = getDateRange(days);
    return {
      operation_type: 'custom_search',
      query: 'machine learning breakthrough OR neural networks advancement',
      date_from: from,
      date_to: to,
      sources: ['arxiv.org'],
      max_results: 15
    };
  }
};

// Función principal de prueba
async function testDeepResearchAPI() {
  console.log('🧪 Testing Deep Research Operation API...');
  console.log(`📡 Endpoint: ${API_ENDPOINT}`);
  
  // Parsear argumentos de línea de comandos
  const args = process.argv.slice(2);
  const type = args.find(arg => arg.startsWith('--type='))?.split('=')[1] || 'llm_news';
  const days = parseInt(args.find(arg => arg.startsWith('--days='))?.split('=')[1] || '30');
  
  console.log(`🔧 Tipo de prueba: ${type}`);
  console.log(`📅 Días hacia atrás: ${days}`);
  
  if (!examples[type]) {
    console.error(`❌ Tipo de prueba inválido: ${type}`);
    console.log(`✅ Tipos válidos: ${Object.keys(examples).join(', ')}`);
    process.exit(1);
  }
  
  try {
    const requestBody = examples[type](days);
    
    console.log('\n📋 Request Body:');
    console.log(JSON.stringify(requestBody, null, 2));
    
    console.log('\n🚀 Enviando request...');
    const startTime = Date.now();
    
    const response = await fetch(API_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody)
    });
    
    const responseTime = Date.now() - startTime;
    console.log(`⏱️  Tiempo de respuesta: ${responseTime}ms`);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Request falló: ${response.status} ${response.statusText}`);
      console.error(`Error details: ${errorText}`);
      return;
    }
    
    const result = await response.json();
    
    console.log('\n✅ Response recibida:');
    console.log(`Status: ${result.success ? 'SUCCESS' : 'FAILED'}`);
    console.log(`Operation Type: ${result.operation_type}`);
    console.log(`Query: ${result.query}`);
    console.log(`Date Range: ${result.date_range?.from} - ${result.date_range?.to}`);
    console.log(`Total Results: ${result.total_results}`);
    console.log(`Processing Time: ${result.processing_time_ms}ms`);
    
    if (result.results && result.results.length > 0) {
      console.log('\n📰 Sample Results:');
      result.results.slice(0, 3).forEach((item, index) => {
        console.log(`\n${index + 1}. ${item.title}`);
        console.log(`   🔗 ${item.url}`);
        console.log(`   🌐 ${item.domain}`);
        if (item.publishedDate) {
          console.log(`   📅 ${item.publishedDate}`);
        }
      });
      
      if (result.results.length > 3) {
        console.log(`\n... y ${result.results.length - 3} resultados más`);
      }
    }
    
    if (result.error) {
      console.log('\n❌ Error in response:');
      console.log(JSON.stringify(result.error, null, 2));
    }
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    if (error.code === 'ECONNREFUSED') {
      console.error('💡 ¿Está el servidor ejecutándose en localhost:3000?');
    }
  }
}

// Función para mostrar ayuda
function showHelp() {
  console.log(`
🧪 Deep Research Operation API Test Script

Usage:
  node src/scripts/test-deep-research-operation.mjs [options]

Options:
  --type=TYPE     Tipo de prueba (llm_news, general_news, custom_search)
  --days=DAYS     Días hacia atrás para la búsqueda (default: 30)
  --help          Mostrar esta ayuda

Examples:
  node src/scripts/test-deep-research-operation.mjs
  node src/scripts/test-deep-research-operation.mjs --type=llm_news --days=7
  node src/scripts/test-deep-research-operation.mjs --type=general_news --days=60
  node src/scripts/test-deep-research-operation.mjs --type=custom_search --days=90

Test Types:
  llm_news       - Buscar noticias sobre LLMs en Hacker News
  general_news   - Buscar noticias de IA en sitios generales
  custom_search  - Buscar papers académicos en arXiv
`);
}

// Verificar si se solicita ayuda
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  showHelp();
  process.exit(0);
}

// Ejecutar las pruebas
testDeepResearchAPI().catch(error => {
  console.error('❌ Unexpected error:', error);
  process.exit(1);
});
