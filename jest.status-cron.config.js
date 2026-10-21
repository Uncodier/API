// ESM cron entry-point tests mock every business dependency before imports.
export default {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/lib/status/__tests__/cron-observation.test.ts'],
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  extensionsToTreatAsEsm: ['.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { useESM: true, tsconfig: 'tsconfig.json' }] },
};