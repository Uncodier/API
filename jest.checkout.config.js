import base from './jest.commands.config.js';

export default {
  ...base,
  testMatch: [
    '<rootDir>/src/app/api/agents/tools/checkout/**/*.test.ts',
    '<rootDir>/__tests__/catalog/checkout_modifiers.test.ts',
    '<rootDir>/__tests__/reservations/checkout_tools.test.ts',
  ],
};