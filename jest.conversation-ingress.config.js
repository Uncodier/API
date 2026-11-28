import base from './jest.commands.config.js';

// Offline Temporal client contracts: no worker, Next configuration, or .env.
export default {
  ...base,
  testMatch: [
    '<rootDir>/src/lib/services/workflow/__tests__/conversation-ingress.test.ts',
    '<rootDir>/src/app/api/agent/message/__tests__/*.test.ts',
    '<rootDir>/src/app/api/integrations/zavu/webhook/__tests__/pinned-delivery-events.test.ts',
    '<rootDir>/src/lib/services/zavu/__tests__/pinned-delivery-plan.test.ts',
  ],
};