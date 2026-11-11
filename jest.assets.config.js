import base from './jest.harness.config.js';

export default {
  ...base,
  testMatch: [
    '<rootDir>/src/app/api/agents/tools/assets/**/__tests__/**/*.test.ts',
    '<rootDir>/src/lib/services/robot-instance/__tests__/InstanceAssetsService.test.ts',
  ],
};