// Finder suites use hoisted jest.mock factories, like jest.deals.config.js.
// Run with --config jest.finder.config.js; the default ESM transform does not
// support these CommonJS mock factories.
export default {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/lib/services/finder/__tests__/**/*.test.ts'],
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  transform: { '^.+\\.tsx?$': ['ts-jest', { useESM: false, tsconfig: 'tsconfig.json' }] },
};