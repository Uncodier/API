import base from './jest.config.js';

// Offline only: never load Next configuration, credentials or developer .env.
export default {
  ...base,
  testMatch: ['<rootDir>/src/lib/services/billing/__tests__/**/*.test.ts',
    '<rootDir>/src/app/api/site/setup/__tests__/**/*.test.ts'],
  extensionsToTreatAsEsm: [],
  transform: { '^.+\\.tsx?$': ['ts-jest', { useESM: false, tsconfig: 'tsconfig.json' }] },
};