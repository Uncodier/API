import base from './jest.commands.config.js';

// Offline first-contact webhook and RPC boundary regressions; no .env loading.
export default {
  ...base,
  testMatch: [
    '<rootDir>/src/lib/services/zavu/__tests__/whatsapp-app-echo.test.ts',
    '<rootDir>/src/lib/services/zavu/__tests__/conversation-automation-contact.test.ts',
  ],
};