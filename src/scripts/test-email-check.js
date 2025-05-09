#!/usr/bin/env node

/**
 * Test script for email check endpoint
 * 
 * Usage:
 * node test-email-check.js [--site-id=SITE_ID] [--user=USER] [--password=PASSWORD] [--host=HOST] [--port=PORT] [--skip-smtp]
 */

const fetch = require('node-fetch');

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    skipSmtp: false
  };
  
  args.forEach(arg => {
    // Parse --site-id=value format
    if (arg.startsWith('--site-id=')) {
      options.siteId = arg.split('=')[1];
    }
    // Parse --user=value format
    else if (arg.startsWith('--user=')) {
      options.user = arg.split('=')[1];
    }
    // Parse --password=value format
    else if (arg.startsWith('--password=')) {
      options.password = arg.split('=')[1];
    }
    // Parse --host=value format
    else if (arg.startsWith('--host=')) {
      options.host = arg.split('=')[1];
    }
    // Parse --port=value format
    else if (arg.startsWith('--port=')) {
      options.port = parseInt(arg.split('=')[1], 10);
    }
    // Parse --skip-smtp flag
    else if (arg === '--skip-smtp') {
      options.skipSmtp = true;
    }
  });
  
  return options;
}

async function testEmailCheck() {
  try {
    // Get command line arguments
    const options = parseArgs();
    
    // Ensure we have enough information
    if (!options.siteId && !options.user) {
      console.error('Error: Either --site-id or --user is required');
      console.error('Usage: node test-email-check.js [--site-id=SITE_ID] [--user=USER] [--password=PASSWORD] [--host=HOST] [--port=PORT] [--skip-smtp]');
      process.exit(1);
    }
    
    console.log('Testing email check with:');
    if (options.siteId) {
      console.log(`- Site ID: ${options.siteId}`);
    }
    if (options.user) {
      console.log(`- User: ${options.user}`);
    }
    if (options.password) {
      console.log(`- Password: ${'*'.repeat(options.password.length)}`);
    }
    if (options.host) {
      console.log(`- Host: ${options.host}`);
    }
    if (options.port) {
      console.log(`- Port: ${options.port}`);
    }
    console.log(`- Skip SMTP: ${options.skipSmtp ? 'Yes' : 'No'}`);
    
    // Determine base URL (default to localhost)
    const baseUrl = process.env.NEXT_PUBLIC_ORIGIN || process.env.VERCEL_URL || process.env.API_BASE_URL || 'http://localhost:3000';
    const url = new URL('/api/agents/email/check', baseUrl).toString();
    
    console.log(`\nSending request to: ${url}`);
    
    // Build request payload
    const payload = {
      skip_smtp: options.skipSmtp,
    };
    
    if (options.siteId) {
      payload.site_id = options.siteId;
    }
    
    if (options.user) {
      payload.user = options.user;
    }
    
    if (options.password) {
      payload.password = options.password;
    }
    
    if (options.host) {
      payload.host = options.host;
    }
    
    if (options.port) {
      payload.port = options.port;
    }
    
    // Send request
    console.log('Sending payload:', JSON.stringify({
      ...payload,
      password: payload.password ? '*****' : undefined
    }, null, 2));
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    
    // Parse response
    const data = await response.json();
    
    // Display results
    console.log('\n--- RESPONSE ---');
    console.log(`Status: ${response.status} ${response.statusText}`);
    console.log('Headers:', response.headers.raw());
    console.log('Body:', JSON.stringify(data, null, 2));
    
    // Summary
    console.log('\n--- SUMMARY ---');
    if (data.success) {
      console.log('✅ Email configuration is valid!');
      
      console.log('\nIMAP Connection:');
      console.log(`- Status: ${data.imap.success ? 'SUCCESS' : 'FAILED'}`);
      if (data.imap.messages) {
        console.log(`- Total Messages: ${data.imap.messages.total}`);
        console.log(`- Recent Messages: ${data.imap.messages.recent}`);
        console.log(`- Unseen Messages: ${data.imap.messages.unseen}`);
      }
      
      console.log('\nSMTP Connection:');
      if (data.smtp.skipped) {
        console.log('- SKIPPED (as requested)');
      } else {
        console.log(`- Status: ${data.smtp.success ? 'SUCCESS' : 'FAILED'}`);
        if (!data.smtp.success && data.smtp.error) {
          console.log(`- Error: ${data.smtp.error}`);
        }
      }
    } else {
      console.log('❌ Email configuration is NOT valid!');
      
      if (data.error) {
        console.log(`\nError: ${data.error.message || data.error.code || JSON.stringify(data.error)}`);
      }
      
      if (data.imap) {
        console.log('\nIMAP Connection:');
        console.log(`- Status: ${data.imap.success ? 'SUCCESS' : 'FAILED'}`);
        if (!data.imap.success && data.imap.error) {
          console.log(`- Error: ${data.imap.error}`);
        }
      }
      
      if (data.smtp) {
        console.log('\nSMTP Connection:');
        if (data.smtp.skipped) {
          console.log('- SKIPPED (as requested)');
        } else {
          console.log(`- Status: ${data.smtp.success ? 'SUCCESS' : 'FAILED'}`);
          if (!data.smtp.success && data.smtp.error) {
            console.log(`- Error: ${data.smtp.error}`);
          }
        }
      }
    }
    
  } catch (error) {
    console.error('Error running test:', error);
    process.exit(1);
  }
}

// Run the test
testEmailCheck(); 