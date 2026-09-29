import harness from './jest.harness.config.js';

// Offline only: never load Next configuration or developer credentials.
export default {
  ...harness,
  transform: {
    '^.+\\.[jt]sx?$': ['ts-jest', { useESM: false, tsconfig: 'tsconfig.json' }],
  },
  testMatch: [
    '<rootDir>/src/app/api/agents/chat/websocket/__tests__/**/*.test.ts',
    '<rootDir>/src/lib/services/visitor-identity/__tests__/**/*.test.ts',
    '<rootDir>/src/lib/security/__tests__/visitor-session-token.test.ts',
    '<rootDir>/src/app/api/keys/__tests__/route.test.ts',
  ],
};