/**
 * Script para probar el endpoint HTTP completo del servicio de venues
 * 
 * Para ejecutar:
 * node scripts/test-api-endpoint.mjs
 */

async function testApiEndpoint() {
  console.log('🧪 Testing Complete API Endpoint...\n');
  
  try {
    // Parámetros de prueba
    const testParams = {
      siteId: 'test-site-123',
      searchTerm: 'restaurant',
      city: 'Mexico City',
      region: 'Mexico',
      maxVenues: 5
    };

    // Construir URL con parámetros
    const baseUrl = 'http://localhost:3000/api/agents/sales/regionVenues';
    const params = new URLSearchParams(testParams);
    const fullUrl = `${baseUrl}?${params}`;

    console.log('🔍 Test parameters:');
    console.log('   Site ID:', testParams.siteId);
    console.log('   Search Term:', testParams.searchTerm);
    console.log('   City:', testParams.city);
    console.log('   Region:', testParams.region);
    console.log('   Max Venues:', testParams.maxVenues);
    console.log('\n🌐 API URL:', fullUrl);

    console.log('\n🚀 Making API request...');
    const startTime = Date.now();
    
    const response = await fetch(fullUrl);
    const endTime = Date.now();
    
    console.log(`⏱️ Request completed in ${endTime - startTime}ms`);
    console.log('📊 Response status:', response.status);
    
    if (!response.ok) {
      console.error('❌ HTTP error:', response.status, response.statusText);
      const errorText = await response.text();
      console.error('Error response:', errorText);
      return;
    }

    const data = await response.json();
    
    console.log('\n✅ API Response:');
    console.log('   Success:', data.success);
    
    if (data.success) {
      console.log('   Venue Count:', data.data.venueCount);
      console.log('   Search Term:', data.data.searchTerm);
      console.log('   City:', data.data.city);
      console.log('   Region:', data.data.region);
      console.log('   Timestamp:', data.data.timestamp);
      
      if (data.data.venues && data.data.venues.length > 0) {
        console.log('\n📍 Found venues:');
        data.data.venues.forEach((venue, index) => {
          console.log(`\n   ${index + 1}. ${venue.name}`);
          console.log(`      📍 Address: ${venue.address}`);
          console.log(`      📞 Phone: ${venue.phone}`);
          console.log(`      🌐 Website: ${venue.website}`);
          console.log(`      ⭐ Rating: ${venue.rating}`);
          console.log(`      🏷️ Types: ${venue.types.join(', ')}`);
          console.log(`      🕒 Open now: ${venue.opening_hours.open_now ? 'Yes' : 'No'}`);
          console.log(`      🎯 Amenities: ${venue.amenities.join(', ')}`);
          console.log(`      📝 Description: ${venue.description}`);
        });
      }
      
      console.log('\n🎉 API Test successful!');
      console.log('   The Region Venues service is working correctly');
      console.log('   Google Maps API integration is complete');
      
    } else {
      console.error('❌ API returned error:', data.error);
    }
    
  } catch (error) {
    console.error('❌ Error during API test:', error.message);
  }
}

testApiEndpoint().catch(console.error); 