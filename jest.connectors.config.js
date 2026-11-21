import base from './jest.harness.config.js';

// Offline provider, access, lifecycle and route contracts. Never load Next config/.env.
export default {
  ...base,
  moduleNameMapper: { ...base.moduleNameMapper, '^server-only$': '<rootDir>/src/lib/integrations/openrouter/__tests__/server-only.ts' },
  testMatch: [
    '<rootDir>/src/lib/connectors/__tests__/**/*.test.ts',
    '<rootDir>/src/app/api/connectors/**/__tests__/**/*.test.ts',
  ],
};