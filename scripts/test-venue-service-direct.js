/**
 * Script de prueba directa del servicio de venues
 * 
 * Para ejecutar:
 * node scripts/test-venue-service-direct.js
 */

// Cargar variables de entorno
require('dotenv').config();

// Importar el servicio
const { RegionVenuesService } = require('../src/services/sales/RegionVenuesService');

async function testVenueServiceDirect() {
  console.log('🧪 Testing Region Venues Service directly...\n');
  
  try {
    // Crear instancia del servicio
    const venueService = new RegionVenuesService();
    console.log('✅ Service instance created successfully');
    
    // Parámetros de prueba
    const testParams = {
      siteId: 'test-site-123',
      searchTerm: 'restaurant',
      city: 'Mexico City',
      region: 'Mexico',
      limit: 5
    };
    
    console.log('\n🔍 Testing with parameters:');
    console.log('   Search Term:', testParams.searchTerm);
    console.log('   City:', testParams.city);
    console.log('   Region:', testParams.region);
    console.log('   Limit:', testParams.limit);
    
    console.log('\n🚀 Starting venue search...');
    
    // Ejecutar búsqueda
    const startTime = Date.now();
    const result = await venueService.searchRegionVenues(testParams);
    const endTime = Date.now();
    
    console.log(`⏱️  Search completed in ${endTime - startTime}ms`);
    
    if (result.success) {
      console.log('\n✅ Search successful!');
      console.log('   Venues found:', result.venues?.length || 0);
      
      if (result.venues && result.venues.length > 0) {
        console.log('\n📍 Sample venues:');
        result.venues.slice(0, 3).forEach((venue, index) => {
          console.log(`\n   ${index + 1}. ${venue.name}`);
          console.log(`      📍 Address: ${venue.address}`);
          console.log(`      📞 Phone: ${venue.phone}`);
          console.log(`      🌐 Website: ${venue.website}`);
          console.log(`      ⭐ Rating: ${venue.rating}`);
          console.log(`      🏷️  Types: ${venue.types.join(', ')}`);
          console.log(`      🕒 Open now: ${venue.opening_hours.open_now ? 'Yes' : 'No'}`);
          console.log(`      🎯 Amenities: ${venue.amenities.join(', ')}`);
        });
      }
    } else {
      console.error('\n❌ Search failed:');
      console.error('   Error:', result.error);
      
      // Sugerencias de troubleshooting
      console.log('\n🔧 Troubleshooting suggestions:');
      console.log('   1. Check if GOOGLE_CLOUD_API_KEY is set');
      console.log('   2. Verify Google Places API is enabled');
      console.log('   3. Verify Google Geocoding API is enabled');
      console.log('   4. Check API key permissions and restrictions');
      console.log('   5. Verify billing is enabled on Google Cloud Console');
    }
    
  } catch (error) {
    console.error('\n💥 Error during test:');
    console.error('   Message:', error.message);
    console.error('   Stack:', error.stack);
    
    // Troubleshooting específico para errores comunes
    if (error.message.includes('GOOGLE_CLOUD_API_KEY')) {
      console.log('\n🔑 API Key issue detected:');
      console.log('   Make sure GOOGLE_CLOUD_API_KEY is set in your .env file');
      console.log('   The API key should have access to:');
      console.log('   - Google Places API (New)');
      console.log('   - Google Geocoding API');
      console.log('   - Google Maps JavaScript API');
    }
  }
}

// Ejecutar el test
testVenueServiceDirect().catch(console.error); 