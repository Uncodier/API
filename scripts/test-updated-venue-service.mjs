/**
 * Script para probar el servicio de venues actualizado
 * 
 * Para ejecutar:
 * node scripts/test-updated-venue-service.mjs
 */

import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Cargar desde .env.local
try {
  const envLocalPath = join(__dirname, '..', '.env.local');
  dotenv.config({ path: envLocalPath });
} catch (error) {
  dotenv.config();
}

async function testUpdatedVenueService() {
  console.log('🧪 Testing Updated Venue Service...\n');
  
  try {
    // Simular una búsqueda directa con la API que funciona
    const apiKey = process.env.GOOGLE_CLOUD_API_KEY;
    if (!apiKey) {
      console.error('❌ API key not found');
      return;
    }

    // Parámetros de prueba
    const testParams = {
      searchTerm: 'restaurant',
      city: 'Mexico City',
      region: 'Mexico',
      limit: 5
    };

    console.log('🔍 Test parameters:');
    console.log('   Search Term:', testParams.searchTerm);
    console.log('   City:', testParams.city);
    console.log('   Region:', testParams.region);
    console.log('   Limit:', testParams.limit);

    // Paso 1: Geocoding
    console.log('\n🌍 Step 1: Getting coordinates...');
    const geocodingUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(testParams.city + ', ' + testParams.region)}&key=${apiKey}`;
    
    const geocodingResponse = await fetch(geocodingUrl);
    const geocodingData = await geocodingResponse.json();
    
    if (geocodingData.status !== 'OK') {
      console.error('❌ Geocoding failed:', geocodingData.status);
      return;
    }

    const coordinates = geocodingData.results[0].geometry.location;
    console.log('✅ Coordinates found:', coordinates);

    // Paso 2: Nearby Search
    console.log('\n🏪 Step 2: Searching nearby venues...');
    const nearbyUrl = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${coordinates.lat},${coordinates.lng}&radius=10000&type=establishment&keyword=${encodeURIComponent(testParams.searchTerm)}&key=${apiKey}`;
    
    const nearbyResponse = await fetch(nearbyUrl);
    const nearbyData = await nearbyResponse.json();
    
    console.log('📊 Nearby Search Status:', nearbyData.status);
    
    if (nearbyData.status === 'OK') {
      console.log('✅ Nearby Search successful!');
      console.log(`   Found ${nearbyData.results.length} venues`);
      
      // Mostrar los primeros 3 resultados
      const venues = nearbyData.results.slice(0, 3);
      console.log('\n📍 Sample venues:');
      
      for (let i = 0; i < venues.length; i++) {
        const venue = venues[i];
        console.log(`\n   ${i + 1}. ${venue.name}`);
        console.log(`      📍 Address: ${venue.vicinity || 'Not available'}`);
        console.log(`      ⭐ Rating: ${venue.rating || 'Not rated'}`);
        console.log(`      🏷️  Types: ${venue.types ? venue.types.join(', ') : 'Not specified'}`);
        console.log(`      🕒 Open now: ${venue.opening_hours?.open_now ? 'Yes' : 'No/Unknown'}`);
        console.log(`      📍 Place ID: ${venue.place_id}`);
        
        // Opcional: Obtener detalles adicionales
        if (venue.place_id) {
          try {
            const detailsUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${venue.place_id}&fields=formatted_phone_number,website,formatted_address&key=${apiKey}`;
            const detailsResponse = await fetch(detailsUrl);
            const detailsData = await detailsResponse.json();
            
            if (detailsData.status === 'OK') {
              console.log(`      📞 Phone: ${detailsData.result.formatted_phone_number || 'Not available'}`);
              console.log(`      🌐 Website: ${detailsData.result.website || 'Not available'}`);
              console.log(`      📍 Full Address: ${detailsData.result.formatted_address || 'Not available'}`);
            }
          } catch (detailsError) {
            console.log(`      ⚠️ Could not get details for this venue`);
          }
        }
      }
      
      console.log('\n🎉 Test completed successfully!');
      console.log('   The venue service should now work with Google Maps API');
      console.log('   You can test the full API endpoint now');
      
    } else {
      console.error('❌ Nearby Search failed:', nearbyData.status);
      console.error('   Error message:', nearbyData.error_message);
    }
    
  } catch (error) {
    console.error('❌ Error during test:', error);
  }
}

testUpdatedVenueService().catch(console.error); 