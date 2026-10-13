import base from './jest.config.js';

// Offline scheduling contracts: no developer environment or Next configuration.
export default {
  ...base,
  testMatch: [
    '<rootDir>/__tests__/scheduling/**/*.test.ts',
    '<rootDir>/__tests__/calendars/**/*.test.ts',
    '<rootDir>/src/lib/scheduling/__tests__/**/*.test.ts',
    '<rootDir>/src/app/api/agents/tools/scheduling/**/__tests__/**/*.test.ts',
  ],
  extensionsToTreatAsEsm: [],
  transform: { '^.+\\.tsx?$': ['ts-jest', { useESM: false, tsconfig: 'tsconfig.json' }] },
};