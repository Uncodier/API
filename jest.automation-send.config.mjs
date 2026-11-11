export default {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/lib/services/channels/__tests__/automation-send-*.test.ts'],
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  transform: { '^.+\\.tsx?$': ['ts-jest', { useESM: false, tsconfig: 'tsconfig.json' }] },
};