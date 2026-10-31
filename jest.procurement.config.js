import base from './jest.harness.config.js';

export default {
  ...base,
  testMatch: ['<rootDir>/src/lib/procurement/**/__tests__/**/*.test.ts'],
};