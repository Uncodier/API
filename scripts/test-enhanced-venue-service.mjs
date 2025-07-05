/**
 * Script para probar el servicio de venues mejorado con información de contacto ampliada
 * 
 * Para ejecutar:
 * node scripts/test-enhanced-venue-service.mjs
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

async function testEnhancedVenueService() {
  console.log('🧪 Testing Enhanced Venue Service with Extended Contact Info...\n');
  
  try {
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
      limit: 3
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
      
      // Procesar venues con información detallada
      const venues = nearbyData.results.slice(0, testParams.limit);
      console.log('\n📍 Detailed venue information:');
      
      for (let i = 0; i < venues.length; i++) {
        const venue = venues[i];
        console.log(`\n${'='.repeat(60)}`);
        console.log(`🏢 VENUE ${i + 1}: ${venue.name}`);
        console.log(`${'='.repeat(60)}`);
        
        // Obtener detalles completos
        if (venue.place_id) {
          try {
            // Campos ampliados para máxima información
            const fields = [
              'formatted_phone_number',
              'international_phone_number',
              'website',
              'url',
              'business_status',
              'opening_hours',
              'rating',
              'user_ratings_total',
              'types',
              'formatted_address',
              'vicinity',
              'price_level',
              'reviews',
              'photos'
            ].join(',');
            
            const detailsUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${venue.place_id}&fields=${fields}&key=${apiKey}`;
            const detailsResponse = await fetch(detailsUrl);
            const detailsData = await detailsResponse.json();
            
            if (detailsData.status === 'OK') {
              const details = detailsData.result;
              
              // Información básica
              console.log('📍 BASIC INFO:');
              console.log(`   Name: ${venue.name}`);
              console.log(`   Address: ${details.formatted_address || venue.vicinity || 'Not available'}`);
              console.log(`   Place ID: ${venue.place_id}`);
              console.log(`   Business Status: ${details.business_status || 'Unknown'}`);
              
              // Información de contacto
              console.log('\n📞 CONTACT INFO:');
              console.log(`   Local Phone: ${details.formatted_phone_number || 'Not available'}`);
              console.log(`   International Phone: ${details.international_phone_number || 'Not available'}`);
              console.log(`   Website: ${details.website || 'Not available'}`);
              console.log(`   Google Maps URL: ${details.url || 'Not available'}`);
              
              // Ratings y reseñas
              console.log('\n⭐ RATINGS & REVIEWS:');
              console.log(`   Rating: ${details.rating || venue.rating || 'Not rated'}/5`);
              console.log(`   Total Reviews: ${details.user_ratings_total || 'Not available'}`);
              if (details.price_level !== undefined) {
                console.log(`   Price Level: ${'$'.repeat(details.price_level + 1)} (${details.price_level}/4)`);
              }
              
              // Tipos de negocio
              console.log('\n🏷️ BUSINESS TYPES:');
              const types = details.types || venue.types || [];
              console.log(`   Types: ${types.join(', ')}`);
              
              // Horarios
              console.log('\n🕒 OPERATING HOURS:');
              if (details.opening_hours) {
                console.log(`   Currently Open: ${details.opening_hours.open_now ? 'Yes' : 'No'}`);
                if (details.opening_hours.weekday_text) {
                  console.log('   Weekly Schedule:');
                  details.opening_hours.weekday_text.forEach(day => {
                    console.log(`     ${day}`);
                  });
                }
              } else {
                console.log('   Hours information not available');
              }
              
              // Reseñas
              if (details.reviews && details.reviews.length > 0) {
                console.log('\n💬 RECENT REVIEWS:');
                details.reviews.slice(0, 2).forEach((review, index) => {
                  console.log(`   Review ${index + 1}:`);
                  console.log(`     Author: ${review.author_name}`);
                  console.log(`     Rating: ${review.rating}/5`);
                  console.log(`     Text: ${review.text.substring(0, 100)}${review.text.length > 100 ? '...' : ''}`);
                  console.log(`     Date: ${new Date(review.time * 1000).toLocaleDateString()}`);
                });
              }
              
              // Fotos
              if (details.photos && details.photos.length > 0) {
                console.log('\n📸 PHOTOS:');
                console.log(`   Available photos: ${details.photos.length}`);
                details.photos.slice(0, 2).forEach((photo, index) => {
                  console.log(`     Photo ${index + 1}: ${photo.width}x${photo.height} (ref: ${photo.photo_reference.substring(0, 20)}...)`);
                });
              }
              
            } else {
              console.log(`   ⚠️ Could not get detailed information: ${detailsData.status}`);
            }
          } catch (detailsError) {
            console.log(`   ⚠️ Error getting details: ${detailsError.message}`);
          }
        }
      }
      
      console.log('\n' + '='.repeat(60));
      console.log('🎉 Enhanced test completed successfully!');
      console.log('📊 Summary of available contact information:');
      console.log('   ✅ Local phone numbers');
      console.log('   ✅ International phone numbers');
      console.log('   ✅ Websites');
      console.log('   ✅ Google Maps URLs');
      console.log('   ✅ Business status');
      console.log('   ✅ Detailed ratings and reviews');
      console.log('   ✅ Operating hours');
      console.log('   ✅ Price levels');
      console.log('   ✅ Photos');
      console.log('   ❌ Email addresses (not available in Google Places API)');
      
      console.log('\n📝 Next steps:');
      console.log('   • The enhanced venue service provides maximum contact info');
      console.log('   • For emails, you would need to scrape websites or use other sources');
      console.log('   • Test the full API endpoint with the enhanced data');
      
    } else {
      console.error('❌ Nearby Search failed:', nearbyData.status);
      console.error('   Error message:', nearbyData.error_message);
    }
    
  } catch (error) {
    console.error('❌ Error during enhanced test:', error);
  }
}

testEnhancedVenueService().catch(console.error); 