import base from './jest.commands.config.js';

export default {
  ...base,
  testMatch: ['<rootDir>/src/app/api/agents/customerSupport/message/__tests__/*.test.ts'],
};