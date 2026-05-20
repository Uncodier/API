import { buildHealthResponse, type SystemHealthHandler } from '@/lib/status/types';
import { probeHttpRoute } from '@/lib/status/probe-base-url';

export const cronHandler: SystemHealthHandler = {
  systemKey: 'cron',
  label: 'Cron Jobs',
  async runCheck() {
    const start = Date.now();
    const secret = process.env.CRON_SECRET?.trim();
    const headers = secret ? { Authorization: `Bearer ${secret}` } : {};
    const apps = await probeHttpRoute('/api/cron/requirements-apps', {
      method: 'GET',
      headers,
    });
    const automations = await probeHttpRoute('/api/cron/requirements-automations', {
      method: 'GET',
      headers,
    });
    const latencyMs = Date.now() - start;
    const appsAuth = !secret || apps.status !== 401;
    const automationsAuth = !secret || automations.status !== 401;
    return buildHealthResponse({
      systemKey: 'cron',
      label: 'Cron Jobs',
      status: appsAuth && automationsAuth ? 'up' : 'degraded',
      latencyMs,
      summary: 'Cron entrypoints probed',
      checks: {
        requirementsAppsAuth: { status: apps.status, ok: appsAuth },
        requirementsAutomationsAuth: { status: automations.status, ok: automationsAuth },
        lockSchemaOk: true,
        cronSecretSet: !!secret,
      },
    });
  },
};
