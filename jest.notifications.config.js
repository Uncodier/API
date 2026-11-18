// Offline notification persistence, CTA and detail contracts; no live providers.
export default {
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/src/lib/services/__tests__/notification-details.test.ts',
    '<rootDir>/src/lib/services/__tests__/TaskNotifier.test.ts',
    '<rootDir>/src/lib/services/platform-api/__tests__/notification*.test.ts',
    '<rootDir>/src/lib/status/__tests__/notifications-functional.test.ts',
    '<rootDir>/src/app/api/agents/tools/system_notification/__tests__/*.test.ts',
  ],
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  transform: { '^.+\\.tsx?$': ['ts-jest', { useESM: false, tsconfig: 'tsconfig.json' }] },
};