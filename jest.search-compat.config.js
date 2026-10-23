import base from './jest.config.js';

// Isolated, offline-only contracts. Do not load developer .env or Next config.
export default {
  ...base,
  testMatch: [
    '<rootDir>/scripts/__tests__/azure-search-*.test.ts',
    '<rootDir>/src/lib/services/search/__tests__/*.test.ts',
    '<rootDir>/src/lib/services/analysis/__tests__/search-memory-data.test.ts',
    '<rootDir>/src/app/api/agents/tools/webSearch/__tests__/*.test.ts',
    '<rootDir>/src/app/api/agents/tools/router/__tests__/tools-router.test.ts',
    '<rootDir>/src/app/api/agents/tools/router/__tests__/screen-access.test.ts',
  ],
  extensionsToTreatAsEsm: [],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { useESM: false, tsconfig: 'tsconfig.json' }],
  },
};