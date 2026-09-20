import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from '@jest/globals';
import {
  issueVisitorSessionToken,
  verifyVisitorSessionToken,
} from '../visitor-session-token';

const originalSecret = process.env.VISITOR_SESSION_TOKEN_SECRET;

describe('visitor session tokens', () => {
  beforeAll(() => {
    process.env.VISITOR_SESSION_TOKEN_SECRET = 'test-session-secret';
  });

  afterAll(() => {
    if (originalSecret === undefined) {
      delete process.env.VISITOR_SESSION_TOKEN_SECRET;
    } else {
      process.env.VISITOR_SESSION_TOKEN_SECRET = originalSecret;
    }
  });

  it('binds a token to its site and session', async () => {
    const token = await issueVisitorSessionToken({
      siteId: 'site-1',
      sessionId: 'session-1',
      visitorId: 'visitor-1',
    });

    await expect(verifyVisitorSessionToken(token, {
      siteId: 'site-1',
      sessionId: 'session-1',
    })).resolves.toBe(true);
    await expect(verifyVisitorSessionToken(token, {
      siteId: 'site-1',
      sessionId: 'session-2',
    })).resolves.toBe(false);
    await expect(verifyVisitorSessionToken(token, {
      siteId: 'site-1',
      sessionId: 'session-1',
      visitorId: 'visitor-2',
    })).resolves.toBe(false);
  });

  it('rejects a modified token', async () => {
    const token = await issueVisitorSessionToken({
      siteId: 'site-1',
      sessionId: 'session-1',
      visitorId: 'visitor-1',
    });
    await expect(verifyVisitorSessionToken(`${token}x`, {
      siteId: 'site-1',
      sessionId: 'session-1',
    })).resolves.toBe(false);
  });

  it('rejects expired tokens', async () => {
    const token = await issueVisitorSessionToken({
      siteId: 'site-1',
      sessionId: 'session-1',
      visitorId: 'visitor-1',
    }, -1);
    await expect(verifyVisitorSessionToken(token, {
      siteId: 'site-1',
      sessionId: 'session-1',
    })).resolves.toBe(false);
  });
});
