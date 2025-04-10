// Test script for Composio API integration
require('dotenv').config({ path: '.env.local' });
const path = require('path');

// We need to use TS-Node to run TypeScript directly
try {
  require('ts-node').register({
    transpileOnly: true,
    compilerOptions: {
      module: 'commonjs'
    }
  });
} catch (e) {
  console.error('ts-node is required to run this script. Install it using: npm install -g ts-node typescript');
  process.exit(1);
}

// Import the service
const { ComposioService } = require('./src/lib/services/composio-service');

/**
 * Test the Composio integrations API
 */
async function testComposioAPI() {
  console.log('Testing Composio API integrations...');
  console.log('API Key:', process.env.COMPOSIO_PROJECT_API_KEY);
  
  // Base URL for API calls
  const baseUrl = 'http://localhost:3000/api'; // Make sure to include /api prefix
  
  try {
    // Get all integrations via API
    console.log('\nFetching all integrations via API:');
    const apiResponse = await fetch(`${baseUrl}/agents/integrations/list`, { method: 'GET' });
    const apiResult = await apiResponse.json();
    
    if (!apiResult.success) {
      throw new Error(`API error: ${apiResult.error}`);
    }
    
    console.log(`Retrieved ${apiResult.data?.length || 0} integrations via API`);
    
    if (apiResult.data && apiResult.data.length > 0) {
      // Display first integration from API
      console.log('\nFirst integration details from API:');
      console.log(JSON.stringify(apiResult.data[0], null, 2));
      
      // Get details for a specific integration via API
      const firstIntegrationId = apiResult.data[0].id;
      console.log(`\nFetching details for integration ID: ${firstIntegrationId} via API`);
      
      const detailsResponse = await fetch(`${baseUrl}/agents/integrations/${firstIntegrationId}`, { method: 'GET' });
      const detailsResult = await detailsResponse.json();
      
      if (!detailsResult.success) {
        throw new Error(`API error fetching details: ${detailsResult.error}`);
      }
      
      console.log('Integration details from API:');
      console.log(JSON.stringify(detailsResult.data, null, 2));
    }
    
    // Print all environment variables to debug
    console.log('Environment variables:');
    console.log(`COMPOSIO_PROJECT_API_KEY: ${process.env.COMPOSIO_PROJECT_API_KEY}`);
    console.log(`NODE_ENV: ${process.env.NODE_ENV}`);
    
    // Direct service call for comparison
    console.log('\nAlso fetching integrations directly via service:');
    const serviceResult = await ComposioService.getIntegrations();
    console.log(`Retrieved ${serviceResult?.length || 0} integrations via direct service call`);
    
  } catch (error) {
    console.error('Error during Composio API test:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
  }
}

testComposioAPI(); 