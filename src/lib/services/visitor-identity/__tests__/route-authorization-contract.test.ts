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
    expect(source).toContain('authorizeVisitorSession(input.request');
    const middleware = readFileSync(
      resolve(process.cwd(), 'src/middleware/requestMiddleware.ts'),
      'utf8'
    );
    expect(middleware).toContain("requestHeaders.delete('x-api-key-data')");
    const apiKeyMiddleware = readFileSync(
      resolve(process.cwd(), 'src/middleware/apiKeyAuth.ts'),
      'utf8'
    );
    expect(apiKeyMiddleware).toContain("requestHeaders.set('x-api-key-data'");
    expect(apiKeyMiddleware).toContain("headers.delete('x-auth-user-id')");
    expect(apiKeyMiddleware).toContain("headers.delete('x-auth-validated')");
    expect(apiKeyMiddleware).not.toContain("if (origin) {\n");
    for (const middlewareFile of ['src/middleware.js', 'middleware.js']) {
      const entrypoint = readFileSync(resolve(process.cwd(), middlewareFile), 'utf8');
      expect(entrypoint).toContain('middleware/requestMiddleware');
      expect(entrypoint).toContain('export default requestMiddleware');
    }
  });

  it.each(routeFiles)('%s invokes canonical visitor session authorization', (file) => {
    const source = readFileSync(resolve(process.cwd(), file), 'utf8');
    expect(source).toContain('visitorSessionAuthorizationService.authorizeBrowserRequest');
    expect(source).toContain('visitorAuthorizationErrorResponse');
  });

  it('native WebSocket validates session ownership and forbids conversation switching', () => {
    const source = readFileSync(resolve(process.cwd(), 'wsServer.js'), 'utf8');
    expect(source).toContain('authorizeWebSocketUpgrade(request');
    expect(source).toContain('selectVisitorSessionProtocol');
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
    expect(source).toContain('X-Visitor-Session-Token');
    expect(source).toContain('export async function OPTIONS');
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

    const status = readFileSync(
      resolve(process.cwd(), 'src/app/api/visitors/session/[session_id]/identify/status/route.ts'),
      'utf8'
    );
    expect(status).toContain('visitorIdentityService.restore');
    expect(status).not.toContain('visitorIdentityService.identify');

    for (const operation of ['challenge', 'logout']) {
      const source = readFileSync(
        resolve(process.cwd(), `src/app/api/visitors/session/[session_id]/identify/${operation}/route.ts`),
        'utf8'
      );
      expect(source).toContain('new Response(null, { status: 204 })');
    }
  });

  it('identity routes authorize the visitor session before mutations', () => {
    for (const operation of ['', 'status', 'challenge', 'verify', 'resend', 'logout']) {
      const suffix = operation ? `/${operation}` : '';
      const source = readFileSync(
        resolve(
          process.cwd(),
          `src/app/api/visitors/session/[session_id]/identify${suffix}/route.ts`
        ),
        'utf8'
      );
      expect(source).toContain('authorizeVisitorSession(request');
    }
  });
});
