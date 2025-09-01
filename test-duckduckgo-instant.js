// Test script for DuckDuckGo Instant Answer API
const API_BASE = 'http://localhost:3000/api';

async function testDuckDuckGoInstant() {
  console.log('🧪 Testing DuckDuckGo Instant Answer API...\n');

  // Test 1: GET request with query parameter
  console.log('📋 Test 1: GET request with query parameter');
  try {
    const response = await fetch(`${API_BASE}/duckduckgo-instant?q=machine+learning`);
    const data = await response.json();
    
    console.log(`✅ Status: ${response.status}`);
    console.log(`📊 Success: ${data.success}`);
    console.log(`🔍 Query: ${data.query}`);
    console.log(`📈 Total Results: ${data.total_results}`);
    
    if (data.results && data.results.length > 0) {
      console.log(`📄 First Result: ${data.results[0].title}`);
      console.log(`🔗 URL: ${data.results[0].url}`);
    }
    
    console.log('');
  } catch (error) {
    console.error('❌ Test 1 failed:', error.message);
  }

  // Test 2: POST request for web results
  console.log('📋 Test 2: POST request for web results');
  try {
    const response = await fetch(`${API_BASE}/duckduckgo-instant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: 'artificial intelligence',
        search_type: 'web_results'
      })
    });
    
    const data = await response.json();
    
    console.log(`✅ Status: ${response.status}`);
    console.log(`📊 Success: ${data.success}`);
    console.log(`🔍 Query: ${data.query}`);
    console.log(`📋 Search Type: ${data.search_type}`);
    console.log(`📈 Total Results: ${data.total_results}`);
    console.log(`⏱️ Processing Time: ${data.processing_time_ms}ms`);
    
    if (data.results && data.results.length > 0) {
      console.log(`📄 First Result: ${data.results[0].title}`);
      console.log(`🔗 URL: ${data.results[0].url}`);
    }
    
    console.log('');
  } catch (error) {
    console.error('❌ Test 2 failed:', error.message);
  }

  // Test 3: POST request for instant answer
  console.log('📋 Test 3: POST request for instant answer');
  try {
    const response = await fetch(`${API_BASE}/duckduckgo-instant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: 'what is machine learning',
        search_type: 'instant_answer'
      })
    });
    
    const data = await response.json();
    
    console.log(`✅ Status: ${response.status}`);
    console.log(`📊 Success: ${data.success}`);
    console.log(`🔍 Query: ${data.query}`);
    console.log(`📋 Search Type: ${data.search_type}`);
    console.log(`📈 Total Results: ${data.total_results}`);
    console.log(`⏱️ Processing Time: ${data.processing_time_ms}ms`);
    
    if (data.instant_answer) {
      console.log(`💡 Has Instant Answer: ${!!data.instant_answer.AbstractText}`);
      if (data.instant_answer.AbstractText) {
        console.log(`📝 Abstract: ${data.instant_answer.AbstractText.substring(0, 100)}...`);
      }
    }
    
    console.log('');
  } catch (error) {
    console.error('❌ Test 3 failed:', error.message);
  }

  // Test 4: API documentation
  console.log('📋 Test 4: API documentation');
  try {
    const response = await fetch(`${API_BASE}/duckduckgo-instant`);
    const data = await response.json();
    
    console.log(`✅ Status: ${response.status}`);
    console.log(`📚 API Name: ${data.name}`);
    console.log(`📖 Description: ${data.description}`);
    console.log(`🔢 Version: ${data.version}`);
    
    console.log('');
  } catch (error) {
    console.error('❌ Test 4 failed:', error.message);
  }

  console.log('🎉 Testing completed!');
}

// Run the tests
testDuckDuckGoInstant().catch(console.error);

