// Offline contracts: no environment files or Next configuration loading.
export default {
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/src/lib/messaging/__tests__/exact*.test.ts',
    '<rootDir>/src/app/api/agents/tools/publish/__tests__/test-voice-delivery.test.ts',
  ],
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  transform: { '^.+\\.tsx?$': ['ts-jest', { useESM: false, tsconfig: 'tsconfig.json' }] },
};