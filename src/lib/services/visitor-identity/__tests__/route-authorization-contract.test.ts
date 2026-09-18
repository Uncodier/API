import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const routeFiles = [
  'src/app/api/agents/customerSupport/conversations/route.ts',
  'src/app/api/agents/customerSupport/conversations/messages/route.ts',
  'src/app/api/workflow/customerSupport/route.ts',
  'src/app/api/visitors/upload/route.ts',
  'src/app/api/agents/chat/websocket/route.ts',
  'src/app/api/agents/customerSupport/message/route.ts'
];

describe('browser route authorization contract', () => {
  it('requires session authorization unless middleware authenticated the caller', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/lib/services/visitor-identity/VisitorSessionAuthorizationService.ts'),
      'utf8'
    );
    expect(source).toContain("!request.headers.get('x-api-key-data')");
    for (const middlewareFile of ['src/middleware.js', 'middleware.js']) {
      const middleware = readFileSync(resolve(process.cwd(), middlewareFile), 'utf8');
      expect(middleware).toContain("requestHeaders.delete('x-api-key-data')");
      expect(middleware).toContain("requestHeaders.set('x-api-key-data'");
    }
  });

  it.each(routeFiles)('%s invokes canonical visitor session authorization', (file) => {
    const source = readFileSync(resolve(process.cwd(), file), 'utf8');
    expect(source).toContain('visitorSessionAuthorizationService.authorizeBrowserRequest');
    expect(source).toContain('visitorAuthorizationErrorResponse');
  });

  it('native WebSocket validates session ownership and forbids conversation switching', () => {
    const source = readFileSync(resolve(process.cwd(), 'wsServer.js'), 'utf8');
    expect(source).toContain('authorizeConnection({ site_id, session_id, conversation_id })');
    expect(source).toContain("code: 'REALTIME_AUTH_UNAVAILABLE'");
    expect(source).toContain('subConvId !== conversation_id');
    expect(source).toContain('payload.conversation_id !== conversation_id');
  });

  it('keeps SSE authorization parameters and event names compatible with the Script', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/app/api/agents/chat/websocket/route.ts'),
      'utf8'
    );
    expect(source).toContain("query.get('session_id')");
    expect(source).toContain("type: 'message_history'");
    expect(source).toContain("type: 'connection_established'");
  });

  it('identity routes expose the frontend status and empty-delete contracts', () => {
    const identify = readFileSync(
      resolve(process.cwd(), 'src/app/api/visitors/session/[session_id]/identify/route.ts'),
      'utf8'
    );
    expect(identify).toContain("result.identity_status === 'verification_required'");
    expect(identify).toContain("result.identity_status === 'new_lead'");

    for (const operation of ['challenge', 'logout']) {
      const source = readFileSync(
        resolve(process.cwd(), `src/app/api/visitors/session/[session_id]/identify/${operation}/route.ts`),
        'utf8'
      );
      expect(source).toContain('new Response(null, { status: 204 })');
    }
  });
});
