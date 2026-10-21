// Offline health contracts; no Next configuration or developer environment files.
export default {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/lib/status/__tests__/**/*.test.ts', '<rootDir>/src/lib/status/__tests__/**/*.test.tsx'],
  testPathIgnorePatterns: ['/node_modules/', '/cron-observation.test.ts$'],
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  transform: { '^.+\\.tsx?$': ['ts-jest', { useESM: false, tsconfig: 'tsconfig.json' }] },
};