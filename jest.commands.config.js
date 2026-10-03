import base from './jest.config.js';

// Offline command identity/polling regressions: no Next config or .env loading.
export default {
  ...base,
  setupFiles: [],
  extensionsToTreatAsEsm: [],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { useESM: false, tsconfig: 'tsconfig.json' }],
  },
  testMatch: [
    '<rootDir>/src/lib/agentbase/services/command/__tests__/**/*.test.ts',
    '<rootDir>/src/lib/database/__tests__/command-db.test.ts',
    '<rootDir>/src/app/api/agents/dataAnalyst/__tests__/**/*.test.ts',
  ],
};