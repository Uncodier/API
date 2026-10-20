import base from './jest.config.js';

// Offline guards only: no Next configuration, environment files or live calls.
export default {
  ...base,
  testMatch: ['<rootDir>/src/**/__tests__/manual-disabled*.test.ts'],
  extensionsToTreatAsEsm: [],
  transform: { '^.+\\.tsx?$': ['ts-jest', { useESM: false, tsconfig: 'tsconfig.json' }] },
};