export default {
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/src/lib/services/catalog-search/__tests__/**/*.test.ts',
    '<rootDir>/src/app/api/catalog/**/__tests__/**/*.test.ts',
    '<rootDir>/__tests__/catalog/catalog_commerce*.test.ts',
    '<rootDir>/__tests__/catalog/compact_offerings.test.ts',
  ],
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  transform: { '^.+\\.tsx?$': ['ts-jest', { useESM: false, tsconfig: 'tsconfig.json' }] },
};