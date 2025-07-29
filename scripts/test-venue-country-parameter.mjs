#!/usr/bin/env node

/**
 * Script de prueba para verificar la funcionalidad del parámetro country
 * en la búsqueda de venues regionales
 */

const API_BASE = process.env.API_BASE || 'http://localhost:3000';
const API_KEY = process.env.API_KEY || 'test-key';

async function testVenueSearchWithCountry() {
  console.log('🧪 Testing venue search with country parameter...\n');

  // Test 1: Búsqueda sin country (comportamiento anterior)
  console.log('📍 Test 1: Search without country parameter');
  try {
    const response1 = await fetch(`${API_BASE}/api/agents/sales/regionVenues?siteId=test&searchTerm=restaurant&city=Valencia&region=Valencia&maxVenues=1`, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    
    const result1 = await response1.json();
    console.log('✅ Result without country:', {
      success: result1.success,
      city: result1.data?.city,
      region: result1.data?.region,
      country: result1.data?.country,
      venueCount: result1.data?.venueCount
    });
  } catch (error) {
    console.error('❌ Error in test 1:', error.message);
  }

  console.log('\n');

  // Test 2: Búsqueda con country específico
  console.log('📍 Test 2: Search with country parameter (Spain)');
  try {
    const response2 = await fetch(`${API_BASE}/api/agents/sales/regionVenues?siteId=test&searchTerm=restaurant&city=Valencia&region=Valencia&country=Spain&maxVenues=1`, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    
    const result2 = await response2.json();
    console.log('✅ Result with country (Spain):', {
      success: result2.success,
      city: result2.data?.city,
      region: result2.data?.region,
      country: result2.data?.country,
      venueCount: result2.data?.venueCount
    });
  } catch (error) {
    console.error('❌ Error in test 2:', error.message);
  }

  console.log('\n');

  // Test 3: Búsqueda con country diferente
  console.log('📍 Test 3: Search with country parameter (Venezuela)');
  try {
    const response3 = await fetch(`${API_BASE}/api/agents/sales/regionVenues?siteId=test&searchTerm=restaurant&city=Valencia&region=Carabobo&country=Venezuela&maxVenues=1`, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    
    const result3 = await response3.json();
    console.log('✅ Result with country (Venezuela):', {
      success: result3.success,
      city: result3.data?.city,
      region: result3.data?.region,
      country: result3.data?.country,
      venueCount: result3.data?.venueCount
    });
  } catch (error) {
    console.error('❌ Error in test 3:', error.message);
  }

  console.log('\n');

  // Test 4: POST request con country
  console.log('📍 Test 4: POST request with country parameter');
  try {
    const response4 = await fetch(`${API_BASE}/api/agents/sales/regionVenues`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        siteId: 'test',
        searchTerm: 'restaurant',
        city: 'Madrid',
        region: 'Community of Madrid',
        country: 'Spain',
        maxVenues: 1
      })
    });
    
    const result4 = await response4.json();
    console.log('✅ POST result with country:', {
      success: result4.success,
      city: result4.data?.city,
      region: result4.data?.region,
      country: result4.data?.country,
      venueCount: result4.data?.venueCount
    });
  } catch (error) {
    console.error('❌ Error in test 4:', error.message);
  }

  console.log('\n🎉 Country parameter testing completed!');
}

// Ejecutar las pruebas
testVenueSearchWithCountry().catch(console.error); 