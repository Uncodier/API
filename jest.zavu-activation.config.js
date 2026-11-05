import base from './jest.config.js';

// Offline activation contracts; no developer environment or live provider calls.
export default {
  ...base,
  testMatch: [
    '<rootDir>/src/lib/services/zavu/__tests__/*activation*.test.ts',
    '<rootDir>/src/lib/services/zavu/__tests__/invitation-finalization.test.ts',
    '<rootDir>/src/app/api/integrations/zavu/invitations/**/__tests__/*.test.ts',
    '<rootDir>/src/app/api/integrations/zavu/sms/**/__tests__/*.test.ts',
    '<rootDir>/src/app/api/integrations/zavu/senders/**/activate/__tests__/activation-route.test.ts',
  ],
  extensionsToTreatAsEsm: [],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { useESM: false, tsconfig: 'tsconfig.json' }],
  },
};