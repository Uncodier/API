import base from './jest.config.js';

// Offline contracts only: no Next config, environment files or network integrations.
export default {
  ...base,
  setupFiles: [],
  testMatch: ['<rootDir>/src/lib/services/__tests__/daily-standup-*.test.ts'],
  extensionsToTreatAsEsm: [],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { useESM: false, tsconfig: 'tsconfig.json' }],
  },
};