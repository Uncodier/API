// Test script para verificar el límite de venues
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const testVenuesLimit = async (maxVenues = 1) => {
  try {
    const baseUrl = 'http://localhost:3000';
    const params = new URLSearchParams({
      siteId: 'test-site',
      searchTerm: 'restaurants',
      city: 'Madrid',
      region: 'Spain',
      maxVenues: maxVenues.toString()
    });
    
    const url = `${baseUrl}/api/agents/sales/regionVenues?${params}`;
    
    console.log(`\n🧪 Testing with maxVenues=${maxVenues}`);
    console.log(`📍 URL: ${url}`);
    
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.success) {
      console.log(`✅ Success! Returned ${data.data.venueCount} venues`);
      console.log(`🔢 Expected: ${maxVenues}, Got: ${data.data.venueCount}`);
      
      if (data.data.venueCount !== maxVenues) {
        console.log(`❌ MISMATCH! Expected ${maxVenues} but got ${data.data.venueCount}`);
      }
    } else {
      console.log(`❌ Error:`, data.error);
    }
    
    return data;
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
};

// Ejecutar pruebas
const runTests = async () => {
  console.log('🚀 Starting venue limit tests...');
  
  // Test con diferentes límites
  await testVenuesLimit(1);
  await testVenuesLimit(3);
  await testVenuesLimit(5);
  
  console.log('\n✅ Tests completed!');
};

// Ejecutar solo si se llama directamente
if (import.meta.url === `file://${process.argv[1]}`) {
  runTests();
}

export { testVenuesLimit }; 