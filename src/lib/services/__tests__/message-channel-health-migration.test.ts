import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('message channel health migration in PostgreSQL', () => {
  let results: Record<string, boolean>;

  beforeAll(() => {
    results = JSON.parse(execFileSync(process.execPath, [resolve(process.cwd(),
      'src/lib/services/__tests__/message-channel-health-migration-runner.mjs')],
    { cwd: process.cwd(), encoding: 'utf8' }));
  });

  it('reproduces the original SQLSTATE 42883 before applying the fix', () => {
    expect(results.originalErrorReproduced).toBe(true);
  });

  it('persists WhatsApp/email inbound messages with channel-scoped stable IDs', () => {
    expect(results.inboundChannelsAndDeduplication).toBe(true);
  });

  it('does not record disabled channels, failed messages or update-only origins', () => {
    expect(results.configurationAndOriginGuards).toBe(true);
  });

  it('preserves privileges and rejects spoofed client observations', () => {
    expect(results.authorizationAndPrivilegesPreserved).toBe(true);
  });
});
