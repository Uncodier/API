import base from './jest.config.js';
export default {
  ...base,
  testMatch: ['<rootDir>/src/lib/integrations/openrouter/__tests__/**/*.test.ts'],
  extensionsToTreatAsEsm: [],
  setupFiles: [],
  moduleNameMapper: { ...base.moduleNameMapper, '^server-only$': '<rootDir>/src/lib/integrations/openrouter/__tests__/server-only.ts' },
  transform: { '^.+\\.tsx?$': ['ts-jest', { useESM: false, tsconfig: 'tsconfig.json' }] },
};
