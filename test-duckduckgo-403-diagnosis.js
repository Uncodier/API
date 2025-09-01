// Diagnostic script for DuckDuckGo Instant API 403 errors
const API_BASE = 'http://localhost:3000/api';

async function testDuckDuckGo403Diagnosis() {
  console.log('🔍 DuckDuckGo Instant API 403 Diagnosis\n');

  // Test 1: Basic connection test
  console.log('📋 Test 1: Basic API connection test');
  try {
    const response = await fetch(`${API_BASE}/duckduckgo-instant/test?q=hello`);
    const data = await response.json();
    
    console.log(`✅ Status: ${response.status}`);
    console.log(`📊 Success: ${data.success}`);
    console.log(`🔍 Query: ${data.query}`);
    
    if (data.success) {
      console.log(`📈 API Status: ${data.details.status}`);
      console.log(`📋 Response Headers:`, data.details.headers);
    } else {
      console.log(`❌ Error Details:`, data.details);
    }
    
    console.log('');
  } catch (error) {
    console.error('❌ Test 1 failed:', error.message);
  }

  // Test 2: Different User-Agent test
  console.log('📋 Test 2: Testing with different User-Agent');
  try {
    const response = await fetch(`${API_BASE}/duckduckgo-instant/test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: 'machine learning',
        test_type: 'connection'
      })
    });
    
    const data = await response.json();
    
    console.log(`✅ Status: ${response.status}`);
    console.log(`📊 Success: ${data.success}`);
    console.log(`🔍 Query: ${data.query}`);
    
    if (data.success) {
      console.log(`📈 API Status: ${data.details.status}`);
    } else {
      console.log(`❌ Error Details:`, data.details);
    }
    
    console.log('');
  } catch (error) {
    console.error('❌ Test 2 failed:', error.message);
  }

  // Test 3: Web results test
  console.log('📋 Test 3: Web results search test');
  try {
    const response = await fetch(`${API_BASE}/duckduckgo-instant/test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: 'artificial intelligence',
        test_type: 'web_results'
      })
    });
    
    const data = await response.json();
    
    console.log(`✅ Status: ${response.status}`);
    console.log(`📊 Success: ${data.success}`);
    console.log(`🔍 Query: ${data.query}`);
    
    if (data.success) {
      console.log(`📈 Results Found: ${data.details.results?.length || 0}`);
    } else {
      console.log(`❌ Error: ${data.details.error}`);
    }
    
    console.log('');
  } catch (error) {
    console.error('❌ Test 3 failed:', error.message);
  }

  // Test 4: Direct API test (simulating curl)
  console.log('📋 Test 4: Direct API test (curl simulation)');
  try {
    const testUrl = 'https://api.duckduckgo.com/?q=hello&format=json&no_html=1&skip_disambig=1';
    console.log(`🔗 Testing URL: ${testUrl}`);
    
    const response = await fetch(testUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'MyApp/1.0 (+https://api.example.com)',
      }
    });
    
    console.log(`📈 Direct API Status: ${response.status} ${response.statusText}`);
    console.log(`📋 Response Headers:`, Object.fromEntries(response.headers.entries()));
    
    if (response.ok) {
      const data = await response.json();
      console.log(`✅ Direct API Success: ${!!data.AbstractText || !!data.Results?.length}`);
    } else {
      const errorText = await response.text();
      console.log(`❌ Direct API Error: ${errorText}`);
    }
    
    console.log('');
  } catch (error) {
    console.error('❌ Test 4 failed:', error.message);
  }

  // Test 5: Rate limiting test
  console.log('📋 Test 5: Rate limiting test (multiple requests)');
  try {
    const promises = [];
    for (let i = 0; i < 3; i++) {
      promises.push(
        fetch(`${API_BASE}/duckduckgo-instant/test?q=test${i}`)
          .then(r => r.json())
          .then(data => ({ index: i, success: data.success, status: data.details?.status }))
      );
    }
    
    const results = await Promise.all(promises);
    
    results.forEach(result => {
      console.log(`📊 Request ${result.index}: Success=${result.success}, Status=${result.status}`);
    });
    
    console.log('');
  } catch (error) {
    console.error('❌ Test 5 failed:', error.message);
  }

  console.log('🎉 Diagnosis completed!');
  console.log('\n📋 Summary:');
  console.log('- If Test 1 fails with 403: IP/User-Agent blocking');
  console.log('- If Test 4 fails with 403: Network/proxy issues');
  console.log('- If Test 5 shows failures: Rate limiting');
  console.log('- If all tests pass: API is working correctly');
}

// Run the diagnosis
testDuckDuckGo403Diagnosis().catch(console.error);
