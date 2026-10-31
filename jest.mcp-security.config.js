import base from './jest.ai.config.js';

export default {
  ...base,
  setupFiles: [],
  testMatch: [
    '<rootDir>/src/app/api/mcp/__tests__/screen-principal.test.ts',
    '<rootDir>/src/lib/security/__tests__/tool-request-principal.test.ts',
    '<rootDir>/src/app/api/agents/tools/router/__tests__/screen-access.test.ts',
    '<rootDir>/src/lib/agentbase/agents/toolEvaluator/executor/__tests__/mcpNativeTools.test.ts',
    '<rootDir>/src/lib/agentbase/agents/toolEvaluator/executor/__tests__/executeTools.mcp-routing.test.ts',
  ],
};