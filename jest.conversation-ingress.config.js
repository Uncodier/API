import base from './jest.commands.config.js';

// Offline Temporal client contracts: no worker, Next configuration, or .env.
export default {
  ...base,
  testMatch: ['<rootDir>/src/lib/services/workflow/__tests__/conversation-ingress.test.ts'],
};