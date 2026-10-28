import base from './jest.config.js';

export default {
  ...base,
  testMatch: [
    '<rootDir>/src/app/api/robots/instance/assistant/__tests__/workflow-build.test.ts',
    '<rootDir>/src/app/api/robots/instance/assistant/__tests__/conversation-recovery-tools.test.ts',
    '<rootDir>/src/app/api/robots/instance/assistant/__tests__/publish-node-binding.test.ts',
    '<rootDir>/src/app/api/robots/instance/assistant/__tests__/bound-node-recovery-integration.test.ts',
    '<rootDir>/src/app/api/robots/instance/assistant/__tests__/conversation-recovery-integration.test.ts',
    '<rootDir>/src/app/api/robots/instance/assistant/__tests__/recovery-turn-guard.test.ts',
    '<rootDir>/src/lib/services/robot-instance/__tests__/assistant-recovery.test.ts',
    '<rootDir>/src/lib/services/robot-instance/__tests__/assistant-stale-recovery.test.ts',
    '<rootDir>/src/lib/services/workflow-robot/__tests__/run-plan-relations.test.ts',
    '<rootDir>/src/lib/services/workflow-robot/__tests__/trigger-sync.test.ts',
  ],
};