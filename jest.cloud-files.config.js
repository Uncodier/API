import base from './jest.harness.config.js';

export default {
  ...base,
  testMatch: [
    '<rootDir>/src/lib/cloud-files/__tests__/**/*.test.ts',
    '<rootDir>/src/app/api/robots/instance/assistant/__tests__/requirement-cloud*.test.ts',
  ],
};