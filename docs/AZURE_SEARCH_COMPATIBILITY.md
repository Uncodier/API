# Azure web search compatibility experiment

> Historical pre-migration results below. The migration has now been applied;
> see [production integration and validation](AZURE_WEB_SEARCH.md). The original
> live measurements are retained, while consumer tests now use the migrated service.

## Scope and outcome

Validated on 2026-10-13 UTC (2026-10-12 local) against the existing direct Azure
chat deployment `gpt-5.2`, using `/openai/v1/responses` and `web_search`.
**The tested search contract is compatible after normalization. No production
provider, route, billing rate, environment file, or dependency was changed.**

The experiment lives entirely in scripts and offline tests. It is not a
production-ready replacement or a quality/cost benchmark against Tavily.

## Live results

Public query: the official Node.js release schedule. No customer data was sent.
Each request used `store: false`, low reasoning effort, `max_tool_calls: 1`, a
1,800 output-token cap, a 60-second client timeout, and no automatic retries.

| Scenario | Result | Latency | Raw hits | Citations | Bing requests | Total tokens |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Initial capability check | PASS | 7,529 ms | 10 | 3 | 1 | 8,781 |
| Basic search + adapter | PASS | 7,297 ms | 11 | 2 | 1 | 8,675 |
| Allow `nodejs.org`, block `github.com` | PASS | 8,451 ms | 10 | 3 | 1 | 8,699 |
| Search + strict JSON Schema | PASS | 6,659 ms | 10 | 2 | 1 | 8,930 |
| Block `github.com` independently | PASS | 9,371 ms | 11 | 5 | 1 | 8,807 |

Five live requests reported **five Bing requests and 43,892 total tokens**
(42,410 input; 1,482 output). Monetary cost was not retrieved or estimated.
Tool output items are not a reliable billing counter: use the returned
`tool_usage.web_search.num_requests`, separately from model token usage.

Confirmed:

- `tool_choice: "required"` produced a completed `web_search_call`.
- `include: ["web_search_call.action.sources", "web_search_call.results"]`
  returned source URLs and search hits with `title`, `url`, and `snippet`.
- Message output contained answer text and `url_citation` annotations.
- All four repeatable cases normalized to five results with nonempty snippets;
  the existing formatter preserved the URLs.
- Domain checks inspected all returned evidence URLs, not just the first five.
  The independent exclusion test avoids mistaking an allow-list effect for a
  working block list.
- Combining native search with `text.format.type: "json_schema"` and
  `strict: true` succeeded. The generated JSON passed the local schema and all
  its result URLs matched provider evidence. This is an observed case, not a
  guarantee of factual correctness for arbitrary generated summaries.

## Contract mapping

| Existing consumer input | Azure evidence |
| --- | --- |
| `answer` | Message `output_text`, preserving inline citations |
| `results[].title` | Search-hit title; citation title when available |
| `results[].url` | Search-hit, source, or citation URL |
| `results[].content` | Search-hit `snippet`; empty if unavailable |

Prefer deterministic normalization of the provider's search evidence over
trusting a model-generated list. Strict JSON output is optional for this design.
Preserve citation metadata as well as the rendered answer in a production
integration; do not discard source attribution to force a legacy shape.

`max_results` is enforced locally by truncation; it does not guarantee the search
engine produces that many results or reduce the provider's work. Likewise,
`include_answer: false` can suppress the returned answer without eliminating the
model's generation cost.

## Offline coverage

The isolated Jest configuration runs **53 passing tests across four suites**
(38 new tests/cases and 15 existing formatter/router regressions). New coverage:

- Request construction, separate domain controls, normalization, deduplication,
  citation titles, missing snippets, empty searches, answer omission and limits.
- Incomplete/failed responses, missing search evidence, malformed payloads,
  HTTP 400/401/403/429/500 and transport failure, with no implicit retry.
- Credential/endpoint pairing, redirect rejection, safe errors and synthetic
  credential redaction assertions. Offline tests never load developer `.env`.
- Unchanged HTTP web-search tool, both assistant wrappers and tools router.
- Unchanged Data Analyst route, multiple-search helper used by Deep Research,
  and Google/DuckDuckGo fallback result transformations.

Consumer tests inject the normalized body at the existing provider boundary.
Database, billing, HTTP and browser dependencies are mocked. They demonstrate
payload compatibility, **not an end-to-end deployed migration**. The Data Analyst
route still contains its separate Tavily request; both request sites must be
unified during the actual migration.

## Limitations and migration decisions

- Only the configured `gpt-5.2` deployment was tested. No compatibility claim for
  Astra, other deployments, another Azure resource, or OpenRouter native search.
- Local execution only; no Vercel deployment, concurrency, load, or latency SLA test.
- No A/B quality or cost comparison with Tavily; no actual Tavily call was made.
- Images, relevance scores, date ranges, and equivalence of Tavily
  `basic`/`advanced`/`comprehensive` were not verified.
- Azure documentation says `external_web_access` is treated as `false`; this is
  indexed/cached web grounding, not a guarantee of live page extraction.
- The installed `openai` SDK is 4.104.0. Its checked-in types recognize the old
  `web_search_preview`, not the tested native tool and includes. These probes use
  built-in `fetch`, matching the current Tavily transport, without upgrading it.
- Provider labels (`tavily_search`, `method: 'tavily'`) and credit accounting
  remain unchanged and require deliberate migration, not a blind rename of
  historical records or unapproved price changes.
- Endpoint restrictions protect probe credentials. Source URL screening is not
  an SSRF-safe downloader: the scripts never fetch returned source URLs.

## Reproduce

No live requests or credentials are needed for the offline suite:

```sh
cd /Users/prado/Desktop/Proyectos/Uncodie/Code/API
node /Users/prado/Desktop/Proyectos/Uncodie/Code/API/node_modules/jest/bin/jest.js --config /Users/prado/Desktop/Proyectos/Uncodie/Code/API/jest.search-compat.config.js --runInBand
```

The live runner reads the project's `.env.local` without modifying it; process
environment values take precedence. It uses paired direct Azure endpoint/key
variables and the existing chat deployment. `AZURE_OPENAI_SEARCH_DEPLOYMENT` can
explicitly select a different existing deployment. No secrets are accepted as
CLI arguments or printed in reports.

Each invocation below makes **one potentially billable Azure request**. Choose a
case explicitly: `basic`, `domains`, `exclude`, or `structured`. No call is made
without `--live`.

```sh
node /Users/prado/Desktop/Proyectos/Uncodie/Code/API/node_modules/tsx/dist/cli.mjs /Users/prado/Desktop/Proyectos/Uncodie/Code/API/scripts/probe-azure-search.ts --live --case=basic
```

On the inspected machine Node was outside the shell PATH; validation used
`/opt/homebrew/bin/node`. No raw live response or credential fixture is stored.

References:
- [Azure Responses web search](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/web-search)
- [Azure structured outputs](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/structured-outputs)