// Test simple queries with DuckDuckGo Instant API
const API_BASE = 'http://localhost:3000/api';

async function testSimpleQueries() {
  console.log('🧪 Testing simple queries with DuckDuckGo Instant API\n');

  const simpleQueries = [
    'machine learning',
    'artificial intelligence', 
    'neural networks',
    'hello',
    'test'
  ];

  for (const query of simpleQueries) {
    console.log(`📋 Testing query: "${query}"`);
    
    try {
      const response = await fetch(`${API_BASE}/duckduckgo-instant/test`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: query,
          test_type: 'web_results'
        })
      });
      
      const data = await response.json();
      
      console.log(`✅ Status: ${response.status}`);
      console.log(`📊 Success: ${data.success}`);
      console.log(`📈 Results: ${data.details?.results?.length || 0}`);
      
      if (data.success && data.details?.results?.length > 0) {
        console.log(`📄 First result: ${data.details.results[0].title}`);
        console.log(`🔗 URL: ${data.details.results[0].url}`);
      } else {
        console.log(`❌ No results found`);
      }
      
      console.log('');
      
    } catch (error) {
      console.error(`❌ Test failed for "${query}":`, error.message);
      console.log('');
    }
  }

  console.log('🎉 Simple query testing completed!');
}

// Run the test
testSimpleQueries().catch(console.error);
