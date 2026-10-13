/** Explicit live verification of the production adapter, without DB writes or internal credit deductions. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { searchWeb } from '../src/lib/services/search/web-search';
import { formatWebSearchPayload } from '../src/app/api/agents/tools/webSearch/webSearch-format';

async function main() {
  const args = process.argv.slice(2);
  const depth = args.find(arg => arg.startsWith('--depth='))?.slice(8);
  if (!args.includes('--live') || !depth || !['basic', 'advanced', 'comprehensive'].includes(depth)
    || args.some(arg => arg !== '--live' && arg !== `--depth=${depth}`)) {
    console.error('Requires --live --depth=basic|advanced|comprehensive; no request submitted');
    process.exitCode = 2;
    return;
  }
  let local: Record<string, string> = {};
  try { local = parse(readFileSync(fileURLToPath(new URL('../.env.local', import.meta.url)))); } catch { /* Use process env. */ }
  for (const [name, value] of Object.entries(local)) if (process.env[name] === undefined) process.env[name] = value;
  const result = await searchWeb('Find the official Node.js release schedule and summarize its lifecycle with citations.', {
    search_depth: depth, max_results: 5, include_domains: ['nodejs.org'], exclude_domains: ['github.com'],
  });
  if (!result.success) {
    console.error(JSON.stringify(result));
    process.exitCode = 1;
    return;
  }
  const payload = formatWebSearchPayload(result.data);
  const checks = {
    results: payload.results.length > 0,
    snippets: payload.results.some(hit => hit.snippet.length > 0),
    urlsPreserved: payload.results.every(hit => payload.text.includes(hit.url)),
    citations: result.data.citations.length > 0,
    domains: result.data.sources.every(source => {
      const host = new URL(source.url).hostname;
      return host === 'nodejs.org' || host.endsWith('.nodejs.org');
    }),
    bingUsage: (result.data.tool_usage?.web_search?.num_requests ?? 0) > 0,
  };
  const passed = Object.values(checks).every(Boolean);
  console.log(JSON.stringify({ passed, depth, checks, response_time: result.data.response_time,
    provider: result.data.provider, results: payload.results.length,
    citations: result.data.citations.length, usage: result.data.usage, tool_usage: result.data.tool_usage }, null, 2));
  if (!passed) process.exitCode = 1;
}

main().catch(() => {
  console.error('Production search smoke failed; raw error suppressed');
  process.exitCode = 1;
});