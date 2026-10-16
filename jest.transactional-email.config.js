// Offline contracts: never load Next config, .env.local or live provider clients.
export default {
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/src/lib/services/email/__tests__/transactional-email*.test.ts',
    '<rootDir>/src/app/api/auth/send-email-hook/__tests__/*.test.ts',
    '<rootDir>/src/app/api/agents/tools/system_notification/__tests__/*.test.ts',
    '<rootDir>/src/app/api/cron/shared/__tests__/harness-support.test.ts',
  ],
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  transform: { '^.+\\.tsx?$': ['ts-jest', { useESM: false, tsconfig: 'tsconfig.json' }] },
};
