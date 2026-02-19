# MCP Server (Uncodie tools)

MCP (Model Context Protocol) server that exposes the same agent tools used by the assistant (`getAssistantTools`). Two ways to run:

- **stdio** (this folder): run `npm run mcp`; Cursor or other clients spawn the process and talk over stdin/stdout.
- **HTTP**: deploy your API and expose `POST /api/mcp`; clients connect to your URL with an API key.

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MCP_SITE_ID` | Yes (for both) | — | Site ID used to build the tool list (same context as the assistant). |
| `MCP_USER_ID` | No | — | User ID for tools that require it. |
| `MCP_INSTANCE_ID` | No | `default` | Instance ID for tools that require it. |

HTTP auth uses the **same API keys as the rest of the API** (middleware): `SERVICE_API_KEY` (env) or keys stored in the DB (`api_keys` table, validated via `ApiKeyService`). No separate MCP-specific keys.

Load these from `.env` or `.env.local`. The server uses the same code as the API (including `getAssistantTools` and tool implementations), so any environment variables required by the API (e.g. Supabase URL and keys) must also be available.

---

## HTTP endpoint (for hosting for others)

If you deploy your API (e.g. on Vercel) and want others to use your tools over the network:

1. Set **`MCP_SITE_ID`** (and optionally `MCP_USER_ID`, `MCP_INSTANCE_ID`) in your deployment environment.
2. Endpoint: **`POST https://<your-api-host>/api/mcp`**
3. Clients use the **same API keys as the rest of your API**: either a key from your DB (`api_keys` table, created e.g. via your keys API) or `SERVICE_API_KEY` (env). Send on every request:
   - **Header:** `Authorization: Bearer <api-key>`  
   - or **Header:** `X-API-Key: <api-key>`
4. Body: JSON-RPC 2.0 (e.g. `tools/list` or `tools/call`). Response is JSON-RPC.

Missing or invalid key returns 401.

**Example (curl):**

```bash
curl -X POST https://your-api.com/api/mcp \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

---

## stdio (local / Cursor)

Run from repo root:

```bash
# With required env set
export MCP_SITE_ID=your-site-id
npm run mcp
```

Or in one line:

```bash
MCP_SITE_ID=your-site-id npm run mcp
```

The process stays running and reads/writes JSON-RPC on stdin/stdout. Stop it with Ctrl+C.

## Add to Cursor

1. Open Cursor MCP settings (e.g. **Cursor Settings → MCP** or the MCP section in settings).
2. Add a new MCP server with:
   - **Command:** `npm run mcp` (or `npx tsx mcp-server/index.ts`)
   - **Working directory:** path to this repo root (the directory that contains `package.json` and `mcp-server/`)
   - **Env:** ensure `MCP_SITE_ID` (and optionally `MCP_USER_ID`, `MCP_INSTANCE_ID`) are set in the environment Cursor uses for this server (e.g. in the same config or via a `.env` file in the repo root that Cursor loads).

No URL or port is used; Cursor spawns the process and talks over stdio.
