// Test script for Composio API integration
require('dotenv').config({ path: '.env.local' });

// Print all environment variables to debug
console.log('Environment variables:');
console.log(`COMPOSIO_PROJECT_API_KEY: ${process.env.COMPOSIO_PROJECT_API_KEY}`);
console.log(`KEY LENGTH: ${process.env.COMPOSIO_PROJECT_API_KEY?.length || 0}`);
console.log(`NODE_ENV: ${process.env.NODE_ENV}`);

// Test simple API functions
async function testComposioAPI() {
  try {
    // Base URL for API calls
    const baseUrl = 'http://localhost:3000/api';
    
    console.log(`\nTesting API endpoint: ${baseUrl}/agents/integrations/list`);
    const response = await fetch(`${baseUrl}/agents/integrations/list`);
    const result = await response.json();
    
    console.log('API response:');
    console.log(JSON.stringify(result, null, 2));
    
  } catch (error) {
    console.error('Error during test:', error);
  }
}

testComposioAPI(); 