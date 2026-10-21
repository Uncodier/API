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
    const route = await probeHttpRoute('/api/ai/text/continuation', { method: 'GET', expectedStatuses: [400, 405] });
    const latencyMs = Date.now() - start;
    const parentOk = parent.status === 'up';
    const routeOk = route.ok;
    const status = !routeOk || parent.status === 'down' ? 'down'
      : parent.status === 'skipped' ? 'skipped' : parentOk ? 'up' : 'degraded';
    return buildHealthResponse({
      systemKey: 'ai_text_continuation',
      label: 'AI Text Continuation',
      status,
      latencyMs,
      summary: !routeOk ? 'Continuation route contract failed'
        : parent.status === 'skipped' ? 'Continuation contract reachable; text generation unverified'
        : parentOk ? 'Continuation contract reachable; parent text inference verified'
        : 'Parent text providers unhealthy',
      checks: {
        parentHealthy: parentOk,
        parentStatus: parent.status,
        continuationRouteRegistered: routeOk,
        continuationHttpStatus: route.status,
        verification: parent.status === 'skipped' && routeOk ? 'unverified' : 'contract',
        inheritedProviders: parent.checks.providers,
      },
      degradedReasons: !parentOk ? ['parent_ai_text_unhealthy'] : undefined,
      probePath: '/api/ai/text/continuation',
    });
  },
};
