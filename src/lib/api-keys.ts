/**
 * API Keys and Secrets for authentication
 * 
 * This file contains API keys and secrets that can be used to authenticate
 * requests to the API. In a production environment, these should be stored
 * in environment variables or a secure database.
 */

// Generate a random string for API key and secret
const generateRandomString = (length: number): string => {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const charactersLength = characters.length;
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
  }
  return result;
};

// API keys and secrets
export const API_KEYS = {
  // Local development key
  local: {
    key: 'site-analyzer-local-key',
    secret: 'site-analyzer-local-secret',
  },
  // Test server key
  test: {
    key: 'site-analyzer-test-key',
    secret: 'site-analyzer-test-secret',
  },
  // Production key (should be stored in environment variables)
  production: {
    key: process.env.API_KEY || 'site-analyzer-prod-key',
    secret: process.env.API_SECRET || 'site-analyzer-prod-secret',
  },
  // Custom key for the other server
  otherServer: {
    key: 'sa-' + generateRandomString(24),
    secret: 'ss-' + generateRandomString(32),
  },
};

// Function to validate API key and secret
export const validateApiKey = (key: string, secret: string): boolean => {
  // Check if the key and secret match any of the defined pairs
  return Object.values(API_KEYS).some(
    (pair) => pair.key === key && pair.secret === secret
  );
};

// Export the API key and secret for the other server
export const OTHER_SERVER_API_KEY = API_KEYS.otherServer.key;
export const OTHER_SERVER_API_SECRET = API_KEYS.otherServer.secret; 