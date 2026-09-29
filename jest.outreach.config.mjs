import base from './jest.config.js';

// Offline, narrow suite; no Next build/config or environment-file loading.
export default {
  ...base,
  testMatch: ['<rootDir>/src/lib/services/outreach/__tests__/**/*.test.ts'],
  extensionsToTreatAsEsm: [],
  transform: { '^.+\\.tsx?$': ['ts-jest', { useESM: false, tsconfig: 'tsconfig.json' }] },
};