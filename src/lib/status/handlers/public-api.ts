import { buildHealthResponse, type SystemHealthHandler } from '@/lib/status/types';
import { probeHttpRoute } from '@/lib/status/probe-base-url';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

const SAMPLE_ROUTES = ['/api/public/content', '/api/public/posts', '/api/public/rss'];

function validRss(body: string, headers: Headers): boolean {
  const contentType = headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (!['application/rss+xml', 'application/xml', 'text/xml'].includes(contentType ?? '')) return false;
  // No document types/entities, HTML document, or extra root elements.
  if (/<!DOCTYPE|<!ENTITY|<html\b/i.test(body) || XMLValidator.validate(body) !== true) return false;
  const parsed = new XMLParser({
    ignoreAttributes: false, processEntities: false, parseTagValue: false,
  }).parse(body);
  if (Object.keys(parsed).some((key) => key !== '?xml' && key !== 'rss')) return false;
  const rss = parsed.rss;
  const channel = rss?.channel;
  return rss?.['@_version'] === '2.0' && channel && !Array.isArray(channel) &&
    ['title', 'link', 'description'].every((key) => typeof channel[key] === 'string' && channel[key].trim() !== '');
}

export const publicApiHandler: SystemHealthHandler = {
  systemKey: 'public_api',
  label: 'Public API',
  async runCheck() {
    const start = Date.now();
    // Never discover a user's site or treat a missing context's 404 as healthy.
    const siteId = process.env.STATUS_PROBE_SITE_ID?.trim();
    if (!siteId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(siteId)) {
      return buildHealthResponse({
        systemKey: 'public_api',
        label: 'Public API',
        status: 'skipped',
        latencyMs: Date.now() - start,
        summary: 'Public responses unverified: STATUS_PROBE_SITE_ID must be a configured UUID',
        checks: { verification: 'unverified', siteContextConfigured: false, routes: [] },
      });
    }
    const routes = await Promise.all(
      SAMPLE_ROUTES.map(async (path) => {
        const query = new URLSearchParams({ site_id: siteId });
        if (path !== '/api/public/rss') query.set('limit', '1');
        const r = await probeHttpRoute(`${path}?${query}`, {
          method: 'GET',
          useServiceKey: false,
          expectedStatuses: [200],
          validateResponse: path === '/api/public/rss' ? validRss : (body, headers) => {
            if (!headers.get('content-type')?.includes('application/json')) return false;
            const result = JSON.parse(body);
            return result?.success === true && Array.isArray(result.data) &&
              typeof result.site?.id === 'string' && result.site.id.toLowerCase() === siteId.toLowerCase();
          },
        });
        return { path, status: r.status, ok: r.ok };
      }),
    );
    const failed = routes.filter((r) => !r.ok);
    const latencyMs = Date.now() - start;
    return buildHealthResponse({
      systemKey: 'public_api',
      label: 'Public API',
      status: failed.length === 0 ? 'up' : failed.length === routes.length ? 'down' : 'degraded',
      latencyMs,
      summary: failed.length === 0 ? 'Public site JSON and RSS responses verified' : `${failed.length}/${routes.length} public response checks failed`,
      checks: { verification: 'response', siteContextConfigured: true, routes },
    });
  },
};
