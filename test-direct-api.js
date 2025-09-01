// Test directo a la DuckDuckGo Instant API
async function testDirectAPI() {
  console.log('🧪 Testing direct DuckDuckGo Instant API\n');

  const testQueries = [
    'machine learning',
    'hello',
    'test'
  ];

  for (const query of testQueries) {
    console.log(`📋 Testing direct API with query: "${query}"`);
    
    try {
      // Llamada directa a la API con parámetros mínimos
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json`;
      console.log(`🔗 URL: ${url}`);
      
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'MyApp/1.0 (+https://api.example.com)',
        }
      });

      console.log(`📈 Status: ${response.status} ${response.statusText}`);
      
      if (response.ok) {
        const data = await response.json();
        
        console.log(`📊 Response keys:`, Object.keys(data));
        console.log(`📊 Has Abstract: ${!!data.AbstractText}`);
        console.log(`📊 Has Results: ${!!data.Results?.length}`);
        console.log(`📊 Has RelatedTopics: ${!!data.RelatedTopics?.length}`);
        console.log(`📊 Has Answer: ${!!data.Answer}`);
        console.log(`📊 Has Definition: ${!!data.Definition}`);
        
        if (data.AbstractText) {
          console.log(`📝 Abstract: ${data.AbstractText.substring(0, 100)}...`);
        }
        
        if (data.Results && data.Results.length > 0) {
          console.log(`📄 First Result: ${data.Results[0].Text}`);
          console.log(`🔗 URL: ${data.Results[0].FirstURL}`);
        }
        
        if (data.RelatedTopics && data.RelatedTopics.length > 0) {
          console.log(`🔗 First Related Topic: ${data.RelatedTopics[0].Text}`);
        }
        
      } else {
        const errorText = await response.text();
        console.log(`❌ Error: ${errorText}`);
      }
      
      console.log('');
      
    } catch (error) {
      console.error(`❌ Test failed for "${query}":`, error.message);
      console.log('');
    }
  }

  console.log('🎉 Direct API testing completed!');
}

// Run the test
testDirectAPI().catch(console.error);
