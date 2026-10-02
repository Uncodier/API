import base from './jest.config.js';

// Offline voice integration contracts. Never load Next config or developer .env.
export default {
  ...base,
  testMatch: [
    '<rootDir>/src/lib/services/zavu/__tests__/voice-*.test.ts',
    '<rootDir>/src/lib/services/zavu/__tests__/inbound-voice-context.test.ts',
    '<rootDir>/src/lib/services/zavu/__tests__/webhook-inbound-message.test.ts',
    '<rootDir>/src/lib/services/zavu/__tests__/signature.test.ts',
    '<rootDir>/src/app/api/integrations/zavu/voice/**/__tests__/**/*.test.ts',
    '<rootDir>/src/app/api/integrations/zavu/voice-tools/__tests__/**/*.test.ts',
    '<rootDir>/src/app/api/integrations/zavu/webhook/__tests__/**/*.test.ts',
    '<rootDir>/src/app/api/agents/tools/contact-human/__tests__/voice-route.test.ts',
    '<rootDir>/src/lib/services/__tests__/tool-execution-context.test.ts',
    '<rootDir>/src/app/api/robots/instance/assistant/__tests__/tool-execution-context.test.ts',
    '<rootDir>/src/app/api/agents/tools/*/__tests__/tool-execution-context.test.ts',
    '<rootDir>/src/app/api/agents/tools/placeVoiceCall/__tests__/*.test.ts',
    '<rootDir>/src/app/api/agents/tools/sendBulkMessages/voice-context.test.ts',
    '<rootDir>/src/app/api/agents/chat/intervention/__tests__/send-intervention-by-channel.test.ts',
  ],
  extensionsToTreatAsEsm: [],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      useESM: false,
      tsconfig: 'tsconfig.json',
    }],
  },
};