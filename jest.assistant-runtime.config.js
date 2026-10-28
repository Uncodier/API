import base from './jest.harness.config.js';

// Offline active-runtime compatibility tests. No Next config or developer .env.
export default {
  ...base,
  testMatch: [
    '<rootDir>/src/app/api/robots/instance/assistant/__tests__/**/*.test.ts',
    '<rootDir>/src/lib/services/robot-instance/__tests__/assistant-recovery-schema.test.ts',
    '<rootDir>/src/lib/services/robot-instance/__tests__/assistant-respawn.test.ts',
    '<rootDir>/src/lib/services/workflow-robot/__tests__/plan-result.test.ts',
    '<rootDir>/src/lib/services/workflow-robot/__tests__/result-contract.test.ts',
    '<rootDir>/src/lib/services/workflow-robot/__tests__/result-materialization.test.ts',
    '<rootDir>/src/lib/services/workflow-robot/__tests__/result-shape.test.ts',
    '<rootDir>/src/lib/services/workflow-robot/__tests__/run-plan.test.ts',
    '<rootDir>/src/lib/services/workflow-robot/__tests__/step-prompt-contract.test.ts',
  ],
  // ESM/import.meta suites run separately rather than transpiling their mocks.
  // ui-media-contract.test.ts is already covered by the full test:ai suite.
  testPathIgnorePatterns: [
    ...base.testPathIgnorePatterns,
    '/workflow-build.test.ts$',
    '/bound-node-recovery-integration.test.ts$',
    '/conversation-recovery-integration.test.ts$',
    '/recovery-turn-guard.test.ts$',
    '/ui-media-contract.test.ts$',
    '/conversation-recovery-tools.test.ts$',
    '/publish-node-binding.test.ts$',
  ],
};