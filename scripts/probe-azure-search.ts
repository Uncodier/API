/** Run explicitly with --live --case=basic|domains|exclude|structured; one paid request per invocation. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { formatWebSearchPayload } from '../src/app/api/agents/tools/webSearch/webSearch-format';
import {
  getProbeConfig, inspectProbeResponse, requestProbe, searchDataSchema, type ProbeCase,
} from './azure-search-compatibility';

async function main() {
  const args = process.argv.slice(2);
  const selected = args.find(arg => arg.startsWith('--case='))?.slice('--case='.length);
  if (!args.includes('--live') || !selected || !['basic', 'domains', 'exclude', 'structured'].includes(selected)
    || args.some(arg => arg !== '--live' && arg !== `--case=${selected}`)) {
    console.error('Requires --live --case=basic|domains|exclude|structured. No network request submitted.');
    process.exitCode = 2;
    return;
  }
  let local: Record<string, string> = {};
  try { local = parse(readFileSync(fileURLToPath(new URL('../.env.local', import.meta.url)))); }
  catch { /* An explicitly configured process environment is sufficient. */ }
  const config = getProbeConfig({ ...local, ...process.env });
  const { raw, elapsedMs } = await requestProbe(config, selected as ProbeCase);
  const inspection = inspectProbeResponse(raw);
  const { data, payload } = inspection;
  const assertions: Record<string, boolean> = {
    completedSearch: inspection.metrics.completedSearchCalls > 0,
    nonemptyResults: data.results.length > 0,
    realSnippets: data.results.some(item => item.content.trim()),
    nonemptyAnswer: Boolean(data.answer.trim()),
    formatterPreservesUrls: data.results.every(item => payload.text.includes(item.url)),
    normalizedLimit: data.results.length <= 5,
  };
  if (selected === 'domains') {
    assertions.allowedDomainsOnly = inspection.evidenceUrls.length > 0 && inspection.evidenceUrls.every(url => {
      const host = new URL(url).hostname;
      return host === 'nodejs.org' || host.endsWith('.nodejs.org');
    });
  }
  if (selected === 'domains' || selected === 'exclude') {
    assertions.blockedDomainAbsent = inspection.evidenceUrls.length > 0 && inspection.evidenceUrls.every(url => {
      const host = new URL(url).hostname;
      return host !== 'github.com' && !host.endsWith('.github.com');
    });
  }
  if (selected === 'structured') {
    let json: unknown;
    try { json = JSON.parse(inspection.outputText); } catch { json = undefined; }
    const parsed = searchDataSchema.safeParse(json);
    assertions.structuredSchema = parsed.success;
    assertions.structuredHasResults = parsed.success && parsed.data.results.length > 0;
    assertions.structuredUrlsGrounded = parsed.success && parsed.data.results.every(
      item => inspection.evidenceUrls.includes(new URL(item.url).href),
    );
    if (parsed.success) {
      const formatted = formatWebSearchPayload(parsed.data);
      assertions.structuredFormatter = formatted.answer === parsed.data.answer.trim()
        && parsed.data.results.every(item => formatted.text.includes(item.url));
    }
  }
  const passed = Object.values(assertions).every(Boolean);
  // Counts only: never persist raw provider data, keys, resource URLs, or account IDs.
  console.log(JSON.stringify({ scenario: selected, passed, elapsedMs, assertions, ...inspection.metrics }, null, 2));
  if (!passed) process.exitCode = 1;
}

main().catch(error => {
  const message = error instanceof Error ? error.message : '';
  const safe = /^(Azure probe |Invalid Azure |Azure search |No completed web search|Invalid result limit)/.test(message);
  console.error(JSON.stringify({ passed: false, error: safe ? message : 'Probe failed; raw error suppressed' }));
  process.exitCode = 1;
});