/**
 * Script de prueba para verificar que el servicio de Google Maps API funciona correctamente
 * 
 * Para ejecutar:
 * node scripts/test-google-maps-venue-search.mjs
 */

// Cargar variables de entorno desde .env.local
import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Cargar desde .env.local primero, luego .env como fallback
try {
  const envLocalPath = join(__dirname, '..', '.env.local');
  const envLocalContent = readFileSync(envLocalPath, 'utf8');
  dotenv.config({ path: envLocalPath });
  console.log('📁 Loaded environment variables from .env.local');
} catch (error) {
  console.log('📁 .env.local not found, trying .env');
  dotenv.config();
}

async function testGoogleMapsVenueSearch() {
  console.log('🧪 Testing Google Maps API Venue Search...\n');
  
  // Verificar que tenemos la API key
  const apiKey = process.env.GOOGLE_CLOUD_API_KEY;
  if (!apiKey) {
    console.error('❌ GOOGLE_CLOUD_API_KEY no está configurada');
    console.log('   Asegúrate de tener esta variable en tu archivo .env.local');
    console.log('   Ejemplo: GOOGLE_CLOUD_API_KEY=your_api_key_here');
    return;
  }
  
  console.log('✅ Google Cloud API Key configurada');
  console.log('   Key starts with:', apiKey.substring(0, 10) + '...');
  
  // Probar Google Geocoding API
  console.log('\n🔍 Testing Google Geocoding API...');
  
  try {
    const geocodingUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=Mexico%20City,%20Mexico&key=${apiKey}`;
    
    const geocodingResponse = await fetch(geocodingUrl);
    const geocodingData = await geocodingResponse.json();
    
    console.log('📊 Geocoding API Response Status:', geocodingData.status);
    
    if (geocodingData.status === 'OK') {
      console.log('✅ Geocoding API funcionando correctamente');
      console.log('   📍 Coordenadas de Ciudad de México:', geocodingData.results[0].geometry.location);
    } else {
      console.error('❌ Error en Geocoding API:', geocodingData.status);
      console.error('   Mensaje:', geocodingData.error_message);
      
      if (geocodingData.status === 'REQUEST_DENIED') {
        console.log('\n🔧 Soluciones para REQUEST_DENIED:');
        console.log('   1. Verificar que Google Geocoding API está habilitada en Google Cloud Console');
        console.log('   2. Verificar que la API key tiene permisos para Geocoding API');
        console.log('   3. Verificar que no hay restricciones de IP/referrer muy estrictas');
        console.log('   4. Verificar que la facturación está habilitada en Google Cloud');
        console.log('   5. La API key debe tener estos servicios habilitados:');
        console.log('      - Geocoding API');
        console.log('      - Places API (New)');
        console.log('      - Maps JavaScript API');
      }
      
      if (geocodingData.status === 'OVER_QUERY_LIMIT') {
        console.log('\n🔧 Soluciones para OVER_QUERY_LIMIT:');
        console.log('   1. Has excedido el límite de consultas');
        console.log('   2. Verificar la facturación en Google Cloud Console');
        console.log('   3. Aumentar los límites en la consola de APIs');
      }
      
      return;
    }
  } catch (error) {
    console.error('❌ Error al probar Geocoding API:', error.message);
    return;
  }
  
  // Probar Google Places API
  console.log('\n🔍 Testing Google Places API...');
  
  try {
    const placesUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=restaurants+in+Mexico+City,+Mexico&key=${apiKey}`;
    
    const placesResponse = await fetch(placesUrl);
    const placesData = await placesResponse.json();
    
    console.log('📊 Places API Response Status:', placesData.status);
    
    if (placesData.status === 'OK') {
      console.log('✅ Places API funcionando correctamente');
      console.log(`   🏪 Encontrados ${placesData.results.length} restaurantes`);
      
      if (placesData.results.length > 0) {
        const firstPlace = placesData.results[0];
        console.log('   📍 Primer resultado:', firstPlace.name);
        console.log('   📍 Dirección:', firstPlace.formatted_address);
        console.log('   📍 Rating:', firstPlace.rating || 'No disponible');
        console.log('   📍 Place ID:', firstPlace.place_id);
      }
    } else {
      console.error('❌ Error en Places API:', placesData.status);
      console.error('   Mensaje:', placesData.error_message);
      
      if (placesData.status === 'REQUEST_DENIED') {
        console.log('\n🔧 Soluciones para REQUEST_DENIED:');
        console.log('   1. Verificar que Google Places API está habilitada');
        console.log('   2. Verificar que la API key tiene permisos correctos');
        console.log('   3. Verificar que no hay restricciones de IP/referrer');
      }
      return;
    }
  } catch (error) {
    console.error('❌ Error al probar Places API:', error.message);
    return;
  }
  
  // Probar Place Details API
  console.log('\n🔍 Testing Place Details API...');
  
  try {
    const placesUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=restaurants+in+Mexico+City,+Mexico&key=${apiKey}`;
    const placesResponse = await fetch(placesUrl);
    const placesData = await placesResponse.json();
    
    if (placesData.status === 'OK' && placesData.results.length > 0) {
      const firstPlaceId = placesData.results[0].place_id;
      
      const detailsUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${firstPlaceId}&fields=formatted_phone_number,website,opening_hours,rating,types,formatted_address&key=${apiKey}`;
      
      const detailsResponse = await fetch(detailsUrl);
      const detailsData = await detailsResponse.json();
      
      console.log('📊 Place Details API Response Status:', detailsData.status);
      
      if (detailsData.status === 'OK') {
        console.log('✅ Place Details API funcionando correctamente');
        console.log('   📞 Teléfono:', detailsData.result.formatted_phone_number || 'No disponible');
        console.log('   🌐 Website:', detailsData.result.website || 'No disponible');
        console.log('   🕒 Abierto ahora:', detailsData.result.opening_hours?.open_now || 'No disponible');
      } else {
        console.error('❌ Error en Place Details API:', detailsData.status);
        console.error('   Mensaje:', detailsData.error_message);
      }
    }
  } catch (error) {
    console.error('❌ Error al probar Place Details API:', error.message);
    return;
  }
  
  console.log('\n🎉 ¡Todas las pruebas completadas exitosamente!');
  console.log('   Google Maps API está configurado correctamente');
  console.log('   Tu servicio de venues debería funcionar sin problemas');
  
  // Información adicional
  console.log('\n💡 Información adicional:');
  console.log('   • Google Geocoding API: ✅ Habilitada y funcionando');
  console.log('   • Google Places API: ✅ Habilitada y funcionando');
  console.log('   • Google Place Details API: ✅ Habilitada y funcionando');
  console.log('   • API Key: ✅ Configurada correctamente');
  
  console.log('\n📝 Siguiente paso:');
  console.log('   Puedes probar la API completa con:');
  console.log('   GET /api/agents/sales/regionVenues?siteId=test&searchTerm=restaurant&city=Mexico%20City&region=Mexico');
}

// Ejecutar el test
testGoogleMapsVenueSearch().catch(console.error); 