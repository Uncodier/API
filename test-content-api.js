// Script para probar la API de contenido para segmentos
const testContentAPI = async () => {
  try {
    console.log('Probando API de contenido para segmentos...');
    
    const response = await fetch('http://localhost:3000/api/site/content', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: 'https://ejemplo.com',
        segment_id: 'seg_content_creators',
        content_types: ['posts', 'videos'],
        limit: 3,
        funnel_stage: 'consideration',
        topics: ['marketing digital', 'redes sociales'],
        aiProvider: 'anthropic',
        aiModel: 'claude-3-5-sonnet-20240620',
        sort_by: 'relevance'
      }),
    });
    
    const data = await response.json();
    
    console.log('Respuesta de la API:');
    console.log('Status:', response.status);
    
    if (response.ok) {
      console.log(`Se encontraron ${data.total_results} resultados totales`);
      console.log(`Se devolvieron ${data.returned_results} recomendaciones`);
      
      console.log('\nRecomendaciones:');
      data.recommendations.forEach((item, index) => {
        console.log(`\n--- Recomendación ${index + 1} ---`);
        console.log(`Título: ${item.title}`);
        console.log(`Tipo: ${item.type}`);
        console.log(`Relevancia: ${item.relevanceScore}`);
        console.log(`URL: ${item.url}`);
      });
      
      console.log('\nMetadatos del análisis:');
      console.log(`Modelo utilizado: ${data.metadata.analysis.modelUsed}`);
      console.log(`Tiempo de procesamiento: ${data.metadata.analysis.processingTime}`);
      console.log(`Métricas de filtrado: ${data.metadata.analysis.filteringMetrics.join(', ')}`);
    } else {
      console.error('Error:', data);
    }
    
  } catch (error) {
    console.error('Error al probar la API:', error);
  }
};

// Ejecutar la prueba
testContentAPI(); 