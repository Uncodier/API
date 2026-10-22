import base from './jest.harness.config.js';

// Offline only: no Next configuration, developer .env, live inference or sandboxes.
export default {
  ...base,
  testMatch: [
    '<rootDir>/src/app/api/cron/workflows/__tests__/**/*.test.ts',
    '<rootDir>/src/app/api/ai/text/continuation/__tests__/**/*.test.ts',
  ],
};