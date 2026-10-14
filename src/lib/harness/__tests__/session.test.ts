import { randomBytes, randomUUID } from 'node:crypto';
import { createSession, sessionRequestSchema } from '../session';

const request = () => ({ objective: 'Implement an offline command-line library.', repository: { url: 'https://example.test/team/library.git' } });

describe('portable session request and initial durable snapshot', () => {
  it('removes explicit credential assignments at admission without weakening code argument handling', () => {
    const secret = randomBytes(24).toString('hex');
    const session = createSession(sessionRequestSchema.parse({ ...request(), objective: `Fix login. password="${secret}"` }));
    expect(JSON.stringify(session)).not.toContain(secret);
    expect(session.request.objective).toContain('[REDACTED]');
  });
  it('accepts arbitrary repository hosts and branches without requiring a product framework or profile', () => {
    const parsed = sessionRequestSchema.parse({ ...request(), repository: { url: 'https://git.example.invalid/team/elixir-library.git', ref: 'feature/cli-2' } });
    expect(parsed).toMatchObject({ repository: { ref: 'feature/cli-2' }, limits: { maxTurns: 100, maxOutputTokens: 4096, maxTotalTokens: 1000000, maxActiveMs: 3600000 } });
    expect(parsed.profile).toBeUndefined();
    const session = createSession(parsed);
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(session).toMatchObject({ status: 'queued', version: 0, turns: 0, allocatedTokens: 0, activeMs: 0, uncertainOperations: [] });
    expect(session.messages).toEqual([{ role: 'user', content: parsed.objective }]);
    expect(session.workspace).toBeUndefined(); expect(session.pending).toBeUndefined();
    expect(Number.isNaN(Date.parse(session.createdAt))).toBe(false);
  });

  it('validates before constructing a session and does not retain mutable caller references', () => {
    const input = sessionRequestSchema.parse(request());
    const id = randomUUID();
    const session = createSession(input, id);
    input.repository.url = 'https://example.test/other.git'; input.limits.maxTurns = 1;
    expect(session.id).toBe(id);
    expect(session.request.repository.url).toBe(request().repository.url);
    expect(session.request.limits.maxTurns).toBe(100);
    expect(() => createSession({ ...input, objective: ' ' })).toThrow();
  });

  it.each([
    'http://example.test/repository', 'file:///tmp/repository', 'ssh://example.test/repository',
    'https://localhost/repository', 'https://127.0.0.1/repository', 'https://169.254.169.254/repository',
    'https://example.test:8080/repository', 'https://example.test/repository?ref=main', 'https://example.test/repository#main',
  ])('rejects an unsafe or ambiguous repository URL: %s', url => {
    expect(sessionRequestSchema.safeParse({ ...request(), repository: { url } }).success).toBe(false);
  });

  it('rejects embedded synthetic credentials rather than persisting a credentialed clone URL', () => {
    const username = randomBytes(18).toString('hex'); const password = randomBytes(24).toString('hex');
    const url = new URL(request().repository.url); url.username = username; url.password = password;
    const parsed = sessionRequestSchema.safeParse({ ...request(), repository: { url: url.toString() } });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain(username); expect(JSON.stringify(parsed)).not.toContain(password);
  });

  it.each([
    { limits: { maxTurns: 0 } }, { limits: { maxTurns: 501 } }, { limits: { maxTurns: 1.5 } },
    { limits: { maxOutputTokens: 255 } }, { limits: { maxOutputTokens: 16385 } },
    { limits: { maxTotalTokens: 1023 } }, { limits: { maxTotalTokens: 10000001 } },
    { limits: { maxActiveMs: 999 } }, { limits: { maxActiveMs: 14400001 } },
    { limits: { maxTurns: Number.NaN } }, { limits: { maxTotalTokens: Number.POSITIVE_INFINITY } },
    { profile: '../untrusted' }, { objective: '' }, { objective: 'x'.repeat(24001) },
    { limits: { bypassBudget: true } }, { administrator: true },
  ])('rejects invalid budgets, unsupported request controls and oversized objectives %#', patch => {
    expect(sessionRequestSchema.safeParse({ ...request(), ...patch }).success).toBe(false);
  });

  it('redacts recognized sensitive objective material in both request and first message while preserving ordinary code', () => {
    const values = Array.from({ length: 4 }, () => randomBytes(24).toString('hex'));
    const url = new URL('https://example.test/receipt'); url.username = values[0]; url.password = values[1];
    url.searchParams.set('signature', values[2]);
    const objective = `  Inspect ${url} Authorization: Bearer ${values[3]} and update maintainer@example.test with form.password.  `;
    const parsed = sessionRequestSchema.parse({ ...request(), objective });
    const session = createSession(parsed);
    for (const sensitive of values) expect(JSON.stringify(session)).not.toContain(sensitive);
    expect(session.request.objective).toContain('maintainer@example.test');
    expect(session.request.objective).toContain('form.password');
    expect(session.messages[0].content).toBe(session.request.objective);
    expect(session.request.objective).not.toMatch(/^\s|\s$/);
  });
});