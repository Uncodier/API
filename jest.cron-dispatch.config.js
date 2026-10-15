// Offline dispatcher tests: no Next configuration, dotenv, database or provider credentials.
export default {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/lib/services/cron/__tests__/**/*.test.ts'],
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  transform: { '^.+\\.tsx?$': ['ts-jest', { useESM: false, tsconfig: 'tsconfig.json' }] },
};