import {
  buildHealthResponse,
  type SystemHealthHandler,
} from '@/lib/status/types';
import { aiTextHandler } from '@/lib/status/handlers/ai/text';
import { probeHttpRoute } from '@/lib/status/probe-base-url';

export const aiTextContinuationHandler: SystemHealthHandler = {
  systemKey: 'ai_text_continuation',
  label: 'AI Text Continuation',
  probePath: '/api/ai/text/continuation',
  async runCheck() {
    const start = Date.now();
    const parent = await aiTextHandler.runCheck();
    const route = await probeHttpRoute('/api/ai/text/continuation', { method: 'GET' });
    const latencyMs = Date.now() - start;
    const parentOk = parent.status === 'up';
    const routeOk = route.status < 500;
    let status = parentOk && routeOk ? 'up' : 'degraded';
    if (!parentOk && parent.status === 'down') status = 'down';
    return buildHealthResponse({
      systemKey: 'ai_text_continuation',
      label: 'AI Text Continuation',
      status,
      latencyMs,
      summary: parentOk
        ? 'Continuation inherits healthy text providers'
        : 'Parent text providers unhealthy',
      checks: {
        parentHealthy: parentOk,
        parentStatus: parent.status,
        continuationRouteRegistered: routeOk,
        continuationHttpStatus: route.status,
        inheritedProviders: parent.checks.providers,
      },
      degradedReasons: !parentOk ? ['parent_ai_text_unhealthy'] : undefined,
      probePath: '/api/ai/text/continuation',
    });
  },
};
