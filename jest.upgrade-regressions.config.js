import base from './jest.config.js';

// Offline ESM regressions: no Next configuration, environment files or live providers.
export default {
  ...base,
  setupFiles: [],
  testMatch: [
    '<rootDir>/src/app/api/agents/tools/publish/__tests__/assistantProtocol.test.ts',
    '<rootDir>/src/app/api/agents/tools/publish/__tests__/content-attempt.test.ts',
    '<rootDir>/src/app/api/agents/tools/publish/__tests__/social-publishing.test.ts',
    '<rootDir>/src/app/api/agents/tools/sendBulkMessages/__tests__/exact-routing.test.ts',
    '<rootDir>/src/lib/integrations/outstand/__tests__/post-request.test.ts',
    '<rootDir>/src/lib/services/__tests__/site-skills-catalog.test.ts',
    '<rootDir>/src/middleware/__tests__/auth-telemetry-lifecycle.test.ts',
    '<rootDir>/src/middleware/__tests__/mcp-redis-lifecycle.test.ts',
    '<rootDir>/src/middleware/__tests__/service-expensive-rate-limit.test.ts',
  ],
};