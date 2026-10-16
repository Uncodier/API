// Offline contracts: no environment files or Next configuration loading.
export default {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/lib/messaging/__tests__/exact*.test.ts'],
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  transform: { '^.+\\.tsx?$': ['ts-jest', { useESM: false, tsconfig: 'tsconfig.json' }] },
};