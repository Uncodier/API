#!/usr/bin/env node

/**
 * WhatsApp Webhook Registration Script
 * 
 * This script registers a webhook for WhatsApp Business API with Meta.
 * It requires the following environment variables:
 * - WHATSAPP_APP_ID: Your WhatsApp App ID from Meta for Developers
 * - WHATSAPP_APP_SECRET: Your WhatsApp App Secret
 * - WHATSAPP_WEBHOOK_URL: Complete URL to your webhook endpoint (https://yourdomain.com/api/integrations/whatsapp/webhook)
 * - WHATSAPP_WEBHOOK_VERIFY_TOKEN: A secret token you choose for verification
 */

const fetch = require('node-fetch');
require('dotenv').config();

// Check required environment variables
const requiredVars = [
  'WHATSAPP_APP_ID',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_WEBHOOK_URL',
  'WHATSAPP_WEBHOOK_VERIFY_TOKEN'
];

for (const varName of requiredVars) {
  if (!process.env[varName]) {
    console.error(`❌ Error: ${varName} environment variable is required`);
    process.exit(1);
  }
}

// Get Meta Graph API access token
async function getAccessToken() {
  const appId = process.env.WHATSAPP_APP_ID;
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  
  const response = await fetch(
    `https://graph.facebook.com/oauth/access_token?client_id=${appId}&client_secret=${appSecret}&grant_type=client_credentials`
  );
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Failed to get access token: ${JSON.stringify(error)}`);
  }
  
  const data = await response.json();
  return data.access_token;
}

// Register the webhook
async function registerWebhook(accessToken) {
  const appId = process.env.WHATSAPP_APP_ID;
  const webhookUrl = process.env.WHATSAPP_WEBHOOK_URL;
  const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  
  const response = await fetch(
    `https://graph.facebook.com/v17.0/${appId}/subscriptions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify({
        object: 'whatsapp_business_account',
        callback_url: webhookUrl,
        verify_token: verifyToken,
        fields: [
          'messages',
          'message_deliveries',
          'message_reads',
          'message_templates'
        ]
      })
    }
  );
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Failed to register webhook: ${JSON.stringify(error)}`);
  }
  
  const data = await response.json();
  console.log('✅ Webhook registered successfully:', data);
}

// Main function
async function main() {
  try {
    console.log('🔄 Getting access token...');
    const accessToken = await getAccessToken();
    
    console.log('🔄 Registering webhook...');
    await registerWebhook(accessToken);
    
    console.log('✅ WhatsApp webhook registration complete!');
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

// Run the script
main(); 