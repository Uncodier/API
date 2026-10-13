# Azure Bing web search integration

## Runtime

`src/lib/services/search/web-search.ts` is the single provider implementation.
It calls Azure OpenAI `POST /openai/v1/responses` with native `web_search`, using
built-in `fetch`. No SDK update, Tavily request, OpenRouter fallback, or new Azure
resource is needed.

All consumers now use this implementation: the HTTP web-search tool, both
assistant wrappers, the tools router, Data Analyst, the multiple-search helper
used by Deep Research, and the Google/DuckDuckGo fallback boundaries. The primary
Google and DuckDuckGo implementations are not replaced. Data Analyst's duplicated
provider request and memory-saving helpers were removed in favor of shared code.

## Server configuration

Select the first configured **pair**:

1. `AZURE_OPENAI_SEARCH_ENDPOINT` and `AZURE_OPENAI_SEARCH_API_KEY` (optional).
2. `MICROSOFT_AZURE_OPENAI_ENDPOINT` and `MICROSOFT_AZURE_OPENAI_API_KEY`.
3. `AZURE_OPENAI_ENDPOINT` and `AZURE_OPENAI_API_KEY`.

If either member of a higher-priority pair is defined, both must be nonempty.
Credentials are never mixed between resources. Keep optional overrides unset,
not empty. The endpoint must be an HTTPS Azure resource origin or `/openai/v1/`
base without query parameters, userinfo, custom port, or fragment.

Deployment precedence: `AZURE_OPENAI_SEARCH_DEPLOYMENT`, then
`MICROSOFT_AZURE_OPENAI_DEPLOYMENT`, then `AZURE_OPENAI_DEPLOYMENT`. The selected
deployment must exist on the selected resource and be a reasoning model supporting
`web_search_call.results`; the existing `gpt-5.2` deployment passed the live checks.
The dated chat API-version variable is not used.

The same variables must be configured on the API server in Vercel. This change
does not deploy, modify private environment files, or transfer local credentials.

## Contracts and safeguards

- Keep `answer`, `results[].title`, `results[].url`, `results[].content` for existing
  consumers. The tools still expose `{title,url,snippet}`.
- Derive results from provider search evidence, not a generated JSON list. Missing
  snippets remain empty. No synthetic relevance scores or publication dates.
- Return/persist `citations`, `sources`, provider token `usage`, and Bing
  `tool_usage.web_search.num_requests`. Source citations remain available even
  when results are capped locally. Render citation links and preserve attribution.
- `basic`: one tool call / low reasoning; `advanced`: two / medium;
  `comprehensive`: three / medium. These are budgets, not exact equivalents of
  Tavily depth. Multiple Bing requests can occur within a tool call.
- `max_results`: local cap of 1–20, not a guarantee or provider cost limit.
  Legacy workflow `limit` is accepted as an alias with the same validation;
  if both fields are supplied they must agree. The HTTP tool keeps its default
  of five results; the shared service keeps ten.
- `include_answer: false`: local omission; generation can still incur token cost.
- Domain allow/block lists are validated and passed natively. Out-of-filter
  provider evidence causes failure, rather than returning misleading success.
- Images, raw content, hard dates and unknown options are rejected. Locale/date
  options unsupported by the Google/DDG fallback also fail before an Azure call;
  the primary providers retain their own capabilities.
  News helpers apply inherited region/language preferences only to primary
  providers. Explicit caller filters are never silently removed. Their default
  limit is 20, and larger legacy helper requests are capped at Azure's capacity.
- One provider request, no automatic retry or redirect; 60-second abort timeout,
  2 MiB response cap, `store: false`, `cache: 'no-store'`, sanitized errors.
- The scripts do not download returned source URLs. URL screening is not a
  substitute for SSRF protections if an extraction tool is added later.

Azure search uses indexed/cached grounding, not guaranteed live scraping. Bing
processing has different terms/compliance boundaries; `store: false` does not
establish residency/retention parity with Azure model inference.

Both Data Analyst analysis entry points share `search-memory-data.ts`. The
consolidator reads capped historical results and uncapped Azure metadata, keeps
deduplicated source URLs, and exposes `answer_attributions` with the exact answer,
query and its citation offsets. Those URLs and annotations are included in each
memory block of the analysis model's context, rather than being discarded after
search. Historical result-only memories and real scores remain supported.

## Commercial accounting

`CreditService.PRICING.WEB_SEARCH` preserves **0.1 credits per query**. New charge
and memory labels are `web_search` / `azure_bing`; historical database entries
are untouched. Model token usage and Bing request counts are separate provider
cost metrics, not the customer's fixed credit price. Configuration admission and
Data Analyst agent lookup occur before internal credit deduction. A provider
failure after admission is not automatically retried or refunded by this change.

## Validation

Local production-adapter smoke checks on `gpt-5.2` passed with domain filtering,
nonempty snippets, preserved URLs, citations, and reported Bing usage:

| Mode | Latency | Results | Citations | Bing requests | Total tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| basic | 11.690 s | 5 | 8 | 1 | 9,184 |
| advanced | 20.947 s | 5 | 8 | 3 | 12,332 |
| comprehensive | 29.455 s | 5 | 11 | 2 | 14,281 |

An earlier advanced invocation was terminated by the command runner's 30-second
limit without a final response. Its outcome/usage is unknown; the subsequent
explicit verification ran in the background. There is no implicit adapter retry.
No monetary cost was calculated; these measurements are not an SLA or an A/B
quality/cost comparison with Tavily. No production Vercel deployment was tested.

The isolated search suite (149 passing cases) and wider AI regression suite
(789 passing cases) validate the migration, alongside a full TypeScript check
and Next production build. Tests mock DB,
billing and provider boundaries; they never load real credentials.

```sh
cd /Users/prado/Desktop/Proyectos/Uncodie/Code/API
node /Users/prado/Desktop/Proyectos/Uncodie/Code/API/node_modules/jest/bin/jest.js --config /Users/prado/Desktop/Proyectos/Uncodie/Code/API/jest.search-compat.config.js --runInBand
node /Users/prado/Desktop/Proyectos/Uncodie/Code/API/node_modules/jest/bin/jest.js --config /Users/prado/Desktop/Proyectos/Uncodie/Code/API/jest.ai.config.js --runInBand
```

Explicit, potentially billable live smoke (one Azure request, no DB/credit writes):

```sh
node /Users/prado/Desktop/Proyectos/Uncodie/Code/API/node_modules/tsx/dist/cli.mjs /Users/prado/Desktop/Proyectos/Uncodie/Code/API/scripts/smoke-web-search.ts --live --depth=basic
```

Use background execution for longer modes. The runner accepts `basic`, `advanced`,
or `comprehensive`, and refuses to make a request without `--live`.

Reference: [Azure Responses web search](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/web-search).