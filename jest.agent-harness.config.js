import base from './jest.harness.config.js';

// Offline only; never load Next config, .env, paid sandboxes or provider APIs.
export default {
  ...base,
  testMatch: [
    '<rootDir>/src/lib/harness/__tests__/**/*.test.ts',
    '<rootDir>/src/app/api/cron/requirements-apps/__tests__/route.test.ts',
  ],
};