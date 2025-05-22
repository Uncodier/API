export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  transformIgnorePatterns: ["node_modules/(?!uuid)"],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1'
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      useESM: true,
      tsconfig: 'tsconfig.json'
    }]
  },
  extensionsToTreatAsEsm: ['.ts', '.tsx'],
  setupFiles: ['<rootDir>/jest.setup.js']
}; 