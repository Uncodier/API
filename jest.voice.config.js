import base from './jest.config.js';

// Offline voice integration contracts. Never load Next config or developer .env.
export default {
  ...base,
  testMatch: [
    '<rootDir>/src/lib/services/zavu/__tests__/voice-*.test.ts',
    '<rootDir>/src/lib/services/zavu/__tests__/inbound-voice-context.test.ts',
    '<rootDir>/src/lib/services/zavu/__tests__/signature.test.ts',
    '<rootDir>/src/app/api/integrations/zavu/voice/**/__tests__/**/*.test.ts',
    '<rootDir>/src/app/api/integrations/zavu/voice-tools/__tests__/**/*.test.ts',
    '<rootDir>/src/app/api/integrations/zavu/webhook/__tests__/**/*.test.ts',
  ],
  extensionsToTreatAsEsm: [],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      useESM: false,
      tsconfig: 'tsconfig.json',
    }],
  },
};