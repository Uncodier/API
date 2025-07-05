/**
 * Script para probar diferentes versiones de Places API
 * 
 * Para ejecutar:
 * node scripts/test-places-api-versions.mjs
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

async function testPlacesAPIVersions() {
  console.log('🧪 Testing different Places API versions...\n');
  
  const apiKey = process.env.GOOGLE_CLOUD_API_KEY;
  if (!apiKey) {
    console.error('❌ API key not found');
    return;
  }

  // Prueba 1: Places API (New) - Text Search
  console.log('🔍 Testing Places API (New) - Text Search...');
  try {
    const newApiUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=restaurants+in+Mexico+City&key=${apiKey}`;
    const response = await fetch(newApiUrl);
    const data = await response.json();
    
    console.log('📊 Text Search Status:', data.status);
    if (data.status === 'OK') {
      console.log('✅ Places API (New) Text Search working!');
      console.log(`   Found ${data.results.length} results`);
    } else {
      console.log('❌ Places API (New) Text Search failed:', data.error_message);
    }
  } catch (error) {
    console.error('❌ Error testing Text Search:', error.message);
  }

  console.log('\n' + '='.repeat(50) + '\n');

  // Prueba 2: Places API - Nearby Search
  console.log('🔍 Testing Places API - Nearby Search...');
  try {
    const nearbyUrl = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=19.4326077,-99.133208&radius=1000&type=restaurant&key=${apiKey}`;
    const response = await fetch(nearbyUrl);
    const data = await response.json();
    
    console.log('📊 Nearby Search Status:', data.status);
    if (data.status === 'OK') {
      console.log('✅ Places API Nearby Search working!');
      console.log(`   Found ${data.results.length} results`);
    } else {
      console.log('❌ Places API Nearby Search failed:', data.error_message);
    }
  } catch (error) {
    console.error('❌ Error testing Nearby Search:', error.message);
  }

  console.log('\n' + '='.repeat(50) + '\n');

  // Prueba 3: Places API - Find Place
  console.log('🔍 Testing Places API - Find Place...');
  try {
    const findPlaceUrl = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=restaurant+Mexico+City&inputtype=textquery&fields=place_id,name,formatted_address&key=${apiKey}`;
    const response = await fetch(findPlaceUrl);
    const data = await response.json();
    
    console.log('📊 Find Place Status:', data.status);
    if (data.status === 'OK') {
      console.log('✅ Places API Find Place working!');
      console.log(`   Found ${data.candidates.length} results`);
    } else {
      console.log('❌ Places API Find Place failed:', data.error_message);
    }
  } catch (error) {
    console.error('❌ Error testing Find Place:', error.message);
  }

  console.log('\n🎯 Summary:');
  console.log('If any of the above tests work, we can adjust the service to use that endpoint.');
  console.log('If none work, the issue is likely in the API key restrictions.');
}

testPlacesAPIVersions().catch(console.error); 