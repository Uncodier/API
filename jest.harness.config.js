import base from './jest.config.js';

// Offline harness contracts/regressions only. Do not load Next config or .env.
export default {
  ...base,
  testMatch: [
    '<rootDir>/src/app/api/cron/shared/__tests__/**/*.test.ts',
    '<rootDir>/src/app/api/cron/requirements-apps/__tests__/**/*.test.ts',
    '<rootDir>/src/app/api/agents/tools/requirement_backlog/__tests__/**/*.test.ts',
    '<rootDir>/src/app/api/robots/instance/assistant/__tests__/plan-exhaustion.test.ts',
    '<rootDir>/src/app/api/robots/instance/assistant/__tests__/route-lifecycle.test.ts',
    '<rootDir>/src/app/api/robots/instance/assistant/__tests__/response-stream.test.ts',
    '<rootDir>/src/app/api/robots/instance/assistant/__tests__/user-message-log.test.ts',
    '<rootDir>/src/lib/custom-automation/__tests__/ai-agent-executor*.test.ts',
    '<rootDir>/src/lib/services/__tests__/cron-*.test.ts',
    '<rootDir>/src/lib/services/__tests__/harness-execution-ownership-sql.test.ts',
    '<rootDir>/src/lib/services/__tests__/requirement-cost-envelope.test.ts',
    '<rootDir>/src/lib/services/__tests__/requirement-backlog-invariants.test.ts',
    '<rootDir>/src/lib/services/__tests__/requirement-backlog-view.test.ts',
    '<rootDir>/src/lib/services/__tests__/requirement-backlog-upsert.test.ts',
    '<rootDir>/src/lib/services/__tests__/tool-operation-result.test.ts',
    '<rootDir>/src/lib/services/__tests__/tool-operation-logging.test.ts',
    '<rootDir>/src/lib/services/__tests__/sandbox-fast-attach.test.ts',
    '<rootDir>/src/lib/services/apps-platform/__tests__/migration-applier.test.ts',
  ],
  extensionsToTreatAsEsm: [],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      useESM: false,
      tsconfig: 'tsconfig.json',
    }],
  },
};