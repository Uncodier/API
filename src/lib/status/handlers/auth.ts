import { buildHealthResponse, type SystemHealthHandler } from '@/lib/status/types';
import { probeHttpRoute } from '@/lib/status/probe-base-url';

export const apiAuthHandler: SystemHealthHandler = {
  systemKey: 'api_auth',
  label: 'API Authentication',
  probePath: '/api/status',
  async runCheck() {
    const start = Date.now();
    const serviceKeySet = !!process.env.SERVICE_API_KEY?.trim();
    const publicStatus = await probeHttpRoute('/api/status', { method: 'GET' });
    const withKey = await probeHttpRoute('/api/agents/apps/list', { method: 'GET' });
    const withoutKey = await probeHttpRoute('/api/agents/apps/list', {
      method: 'GET',
      headers: { 'x-api-key': 'invalid-probe-key' },
    });
    const latencyMs = Date.now() - start;
    const publicOk = publicStatus.ok && publicStatus.status === 200;
    const serviceKeyValid = withKey.ok && withKey.status !== 401;
    const blocksInvalidKey = withoutKey.status === 401;
    return buildHealthResponse({
      systemKey: 'api_auth',
      label: 'API Authentication',
      status: serviceKeySet && serviceKeyValid && blocksInvalidKey && publicOk ? 'up' : 'degraded',
      latencyMs,
      summary: serviceKeyValid ? 'Service API key accepted' : 'Auth probe inconclusive',
      checks: {
        serviceKeySet,
        serviceKeyValid,
        publicStatusRoute: { status: publicStatus.status, ok: publicOk },
        probeWithKey: { status: withKey.status, ok: withKey.ok },
        probeInvalidKey: { status: withoutKey.status, blocked: blocksInvalidKey },
      },
      probePath: '/api/status',
    });
  },
};
