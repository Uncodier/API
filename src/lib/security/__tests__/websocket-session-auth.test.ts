import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { issueVisitorSessionToken } from '../visitor-session-token';
// @ts-expect-error The standalone WebSocket server intentionally uses JavaScript.
import { authorizeWebSocketUpgrade } from '../../../../wsServerAuth.cjs';

const originalSecret = process.env.VISITOR_SESSION_TOKEN_SECRET;

describe('WebSocket visitor session authentication', () => {
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

  it('accepts a token bound to the handshake identifiers', async () => {
    const token = await issueVisitorSessionToken({
      siteId: 'site-1',
      sessionId: 'session-1',
      visitorId: 'visitor-1',
    });
    const request = {
      headers: {
        'sec-websocket-protocol': `visitor-session-token, ${token}`,
      },
    };

    expect(authorizeWebSocketUpgrade(request, {
      siteId: 'site-1',
      sessionId: 'session-1',
      visitorId: 'visitor-1',
    })).toEqual(expect.objectContaining({
      sessionId: 'session-1',
      visitorId: 'visitor-1',
    }));
  });

  it('rejects a token replayed for another session', async () => {
    const token = await issueVisitorSessionToken({
      siteId: 'site-1',
      sessionId: 'session-1',
      visitorId: 'visitor-1',
    });
    const request = {
      headers: {
        'sec-websocket-protocol': `visitor-session-token, ${token}`,
      },
    };

    expect(authorizeWebSocketUpgrade(request, {
      siteId: 'site-1',
      sessionId: 'session-2',
      visitorId: 'visitor-1',
    })).toBeNull();
  });
});
