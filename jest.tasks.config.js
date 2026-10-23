export default {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/app/api/agents/tools/tasks/__tests__/**/*.test.ts'],
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  transform: { '^.+\\.tsx?$': ['ts-jest', { useESM: false, tsconfig: 'tsconfig.json' }] },
};