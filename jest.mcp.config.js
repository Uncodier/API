import base from './jest.config.js';

// Real SDK contracts with isolated catalogs; no Next config, .env or live providers.
export default {
  ...base,
  setupFiles: [],
  testMatch: [
    '<rootDir>/src/lib/mcp/__tests__/**/*.test.ts',
    '<rootDir>/src/app/api/mcp/__tests__/route.test.ts',
    '<rootDir>/src/app/api/mcp/__tests__/http-contract.test.ts',
    '<rootDir>/src/middleware/__tests__/mcp-redis-lifecycle.test.ts',
  ],
};