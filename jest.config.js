export default {
  testEnvironment: 'node',
  transformIgnorePatterns: ["node_modules/(?!uuid)"],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1'
  },
  extensionsToTreatAsEsm: ['.ts', '.tsx'],
}; 