<div align="center">
  <img src="https://raw.githubusercontent.com/brbousnguar/mulewatch/main/docs/logo.png" width="72" alt="mulewatch" />
  <h1>mulewatch</h1>
  <p><strong>Read-only observability for MuleSoft Anypoint Platform, over MCP.</strong><br/>Application logs, historical archive search, Runtime Manager, API Manager and Exchange — for any Anypoint customer, using their own credentials.</p>

  <p>
    <img src="https://img.shields.io/badge/platform-stdio-174f3d?style=flat-square" alt="Platform" />
    <img src="https://img.shields.io/badge/MCP%20SDK-1.30-5b21b6?style=flat-square" alt="MCP SDK" />
    <img src="https://img.shields.io/badge/Node.js-20%2B-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js" />
    <img src="https://img.shields.io/badge/MuleSoft-Anypoint%20Platform-00A2DF?style=flat-square" alt="MuleSoft Anypoint" />
    <img src="https://img.shields.io/npm/v/mulewatch?style=flat-square&color=cb3837&logo=npm&logoColor=white" alt="npm" />
    <img src="https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square" alt="License" />
  </p>
</div>

---

## What it does

mulewatch bridges an MCP client — Claude Desktop, Claude Code, Cursor, OpenClaw — to MuleSoft Anypoint Platform, so you can ask about a Mule estate in plain language and get real answers from the platform APIs. It is aimed at the person holding the pager, not the person writing the flow: no local Mule project is required, and **every tool is read-only**.

- **Application logs** from Runtime Manager, normalized across CloudHub 2.0, Runtime Fabric and legacy CloudHub.
- **Historical log search** through the Anypoint Monitoring Archive API, reaching incidents long past the live tail's rolling buffer.
- **Analysis-ready log payloads** — normalized lines plus counts by priority, logger and replica.
- **Runtime Manager inventory** across Application Manager, CloudHub and hybrid on-prem targets.
- **API Manager** instances and **Exchange** assets, so a single server answers "what is deployed, what is it fronted by, and what broke".

Nothing is hardcoded to one customer: business groups, environments and credentials all come from your own connected app.

### How this relates to the official MuleSoft MCP server

MuleSoft publishes its own MCP server ([`mulesoft-mcp-server`](https://www.npmjs.com/package/mulesoft-mcp-server), [docs](https://docs.mulesoft.com/mulesoft-mcp-server)). It is a **development** tool — it scaffolds Mule projects, generates flows and API specs, and deploys applications, largely from a local project in an IDE.

mulewatch is an **operations** tool. It never writes to your estate, it assumes no local project, and it covers the one area the official server does not address at all: **retrieving and searching application logs**, including historical logs from the Monitoring Archive. The two run happily side by side, and if you want deployment or scaffolding tools, use the official one.

## Requirements

- Node.js 20+
- An Anypoint Platform account with access to the business group you want to read
- A **connected app** (recommended) with *"acts on its own behalf"* enabled, or platform credentials
- For historical log search only: **Anypoint Monitoring enabled** for the organization

### Connected-app scopes

Grant the scopes for the surfaces you intend to use, on the business groups and environments you care about. Anypoint returns a bare `403 Forbidden` when a scope is missing; mulewatch catches that and names the scope you probably need.

| Surface | Scope |
|---|---|
| Environments, business groups | `View Environments`, `View Organization` |
| Runtime Manager apps and logs | `Read Applications` |
| Historical archive search | Anypoint Monitoring `Viewer` |
| API Manager instances | `View APIs Configuration` |
| Exchange assets | Exchange viewer access |

## Setup

Create a connected app in **Anypoint Platform → Access Management → Connected Apps**, choose *"App acts on its own behalf (client credentials)"*, grant the scopes above, and copy the client id and secret.

Configuration is environment variables only — there is no config file and no organization default.

```dotenv
ANYPOINT_CLIENT_ID=your_connected_app_client_id
ANYPOINT_CLIENT_SECRET=your_connected_app_client_secret
```

| Variable | Required | Purpose |
|---|---|---|
| `ANYPOINT_CLIENT_ID` / `ANYPOINT_CLIENT_SECRET` | one auth method | Connected app client credentials, preferred for automation |
| `ANYPOINT_USERNAME` / `ANYPOINT_PASSWORD` | one auth method | Platform login |
| `ANYPOINT_ACCESS_TOKEN` | one auth method | Pre-generated bearer token; takes precedence over the other two |
| `ANYPOINT_ORG_ID` | no | Business group id. Unset means "the organization the credentials belong to" |
| `ANYPOINT_ALLOWED_ENVIRONMENTS` | no | Comma-separated environment names or ids; when set, every tool refuses anything outside the list |
| `ANYPOINT_BASE_URL` | no | Control plane host, defaults to `https://anypoint.mulesoft.com` |
| `ANYPOINT_MONITORING_BASE_URL` | no | Monitoring host, defaults to `https://monitoring.anypoint.mulesoft.com` |

### Business groups

Environments live on **business groups**, not on the root organization. If `anypoint_list_environments` comes back empty, your credentials resolved to the root org — call `anypoint_list_business_groups` to list the ids, then pass one as `orgId` or pin it with `ANYPOINT_ORG_ID`.

### Keeping production out of reach

`ANYPOINT_ALLOWED_ENVIRONMENTS` scopes the whole server, not one tool. With

```dotenv
ANYPOINT_ALLOWED_ENVIRONMENTS=Dev,Sandbox
```

every tool refuses an environment outside the list and says why, whichever business group is targeted. Combine it with a connected app that only has access to those environments for defence in depth.

## Run

Nothing to install — point your MCP client at `npx`:

```json
{
  "mcpServers": {
    "mulewatch": {
      "command": "npx",
      "args": ["-y", "mulewatch"],
      "env": {
        "ANYPOINT_CLIENT_ID": "your_connected_app_client_id",
        "ANYPOINT_CLIENT_SECRET": "your_connected_app_client_secret"
      }
    }
  }
}
```

That block works as-is in Claude Desktop (`claude_desktop_config.json`), Cursor (`.cursor/mcp.json`) and OpenClaw. For Claude Code:

```bash
claude mcp add mulewatch --env ANYPOINT_CLIENT_ID=... --env ANYPOINT_CLIENT_SECRET=... -- npx -y mulewatch
```

From a clone instead:

```bash
npm install
npm run build
npm start
```

The server speaks `stdio`, which is what MCP clients expect. Start with `anypoint_whoami` to confirm credentials, business group and scope before anything else.

---

## Tools

Every tool is read-only. All of them accept `orgId` to override the configured business group.

### `anypoint_whoami`

Confirms which credentials, business group, hosts and environment allowlist the server is running with. No arguments. Call this first when anything fails.

### `anypoint_list_business_groups`

Lists the business groups beneath the credentials' organization, with ids and nesting depth.

```json
{ "rootOrgId": "optional-root-organization-id" }
```

### `anypoint_list_environments`

Lists environments for a business group, filtered by `ANYPOINT_ALLOWED_ENVIRONMENTS` when set.

```json
{ "orgId": "your-business-group-id" }
```

### `anypoint_list_deployed_apps`

Lists deployed Mule applications for an environment, by `environmentId` or `environmentName`.

```json
{ "environmentName": "Dev", "target": "all" }
```

| Option | Purpose |
|---|---|
| `target` | `application_manager` (default), `cloudhub`, `hybrid`, or `all` |
| `limit` | Maximum records to return, default `100` |
| `includeRaw` | Include raw API objects in the response |
| `includeErrors` | Include per-target errors when a target endpoint is unavailable or not permitted |

`application_manager` covers CloudHub 2.0 and Runtime Fabric deployments, `cloudhub` legacy CloudHub, `hybrid` on-prem Runtime Manager. `all` queries every target and reports per-target failures instead of aborting.

### `anypoint_list_app_logs`

Lists the latest Runtime Manager logs for an application.

```json
{ "environmentName": "Dev", "appName": "my-mule-app" }
```

| Option | Purpose |
|---|---|
| `environmentId` | Use instead of `environmentName` |
| `deploymentId` | Use when the app name is ambiguous or already known |
| `specId` | A specific Application Manager deployment spec/config id |
| `target` | `auto` (default), `application_manager`, or `cloudhub` |
| `limit` | Maximum log entries, default `100`, max `500` |
| `offset` | Application Manager log offset, default `0` |
| `descending` | Latest first, default `true` |
| `startTime` / `endTime` | Application Manager time filter, ISO 8601 |
| `includeRaw` | Include the raw API response |
| `includeErrors` | Include failed target errors when `target` is `auto` |

For CloudHub 2.0 and Runtime Fabric the tool resolves `appName` to a deployment, resolves the current spec, then reads that spec's logs. For legacy CloudHub it calls the CloudHub logs endpoint directly.

### `anypoint_get_app_logs_for_analysis`

Same sources as above, but returns an analysis-ready payload rather than a raw list. Prefer it when diagnosing something.

```json
{ "environmentName": "Dev", "appName": "my-mule-app", "limit": 200, "errorOnly": true }
```

Takes every option of `anypoint_list_app_logs`, plus:

| Option | Purpose |
|---|---|
| `searchTerms` | Case-insensitive filters matched against timestamp, priority, message, logger, thread or instance |
| `errorOnly` | Only return `ERROR` and `FATAL` lines |

The response carries `analysis.totalFetched`, `analysis.totalMatched`, `analysis.priorityCounts`, `analysis.loggerCounts`, `analysis.instanceCounts` and `analysis.logs`. Counts describe everything fetched; `logs` holds what matched.

### `anypoint_search_archived_logs`

Searches historical logs through the **Anypoint Monitoring Archive API**, for dates beyond what the live tail can see.

This is the tool the others cannot replace. `anypoint_list_app_logs` and `anypoint_get_app_logs_for_analysis` read Runtime Manager's live tail — a small rolling buffer that can scroll out within minutes on a busy application, no matter what `startTime`/`endTime` you pass. The archive lands files roughly ten minutes after each ten-minute window closes and keeps them far longer.

**Requires Anypoint Monitoring to be enabled for the organization.** Without it every call 403s or 404s; fall back to a manual *Download Logs* export from the Runtime Manager UI.

```json
{
  "environmentName": "Prod",
  "appName": "my-mule-app",
  "date": "2026-08-09",
  "searchTerms": ["Started product import", "Import finished"]
}
```

| Option | Purpose |
|---|---|
| `date` | Required, `YYYY-MM-DD` (UTC) |
| `endDate` | Optional inclusive range end, `YYYY-MM-DD` (UTC), max 7 days total |
| `searchTerms` | Case-insensitive text filters |
| `errorOnly` | Only return `ERROR` and `FATAL` lines |
| `maxEntities` | Cap on replica entities probed during a full-scan fallback, default `150`, max `300` |
| `maxFiles` | Cap on archive files downloaded and parsed, default `100`, max `500` |
| `limit` | Cap on matched lines returned, default `500`, max `2000` |
| `includeRaw` | Include the raw parsed entry alongside the normalized fields |

**How it finds your logs.** The Archive API indexes per replica/pod (`{appName}_{replicaId}`), not per application, so the replica has to be identified before anything can be read. mulewatch first tries the replica ids visible in the live Runtime Manager tail (`entityResolution: "live-replica"`) — pods are usually long-lived between redeploys, so that same replica normally produced the logs on recent past dates too, and a typical lookup costs a handful of archive calls. If that replica has no files for the requested dates — the application was redeployed since, say — it falls back to listing every replica the app has ever had and probing each (`entityResolution: "full-scan"`), bounded by `maxEntities`.

The Archive API allows 60 requests/minute; the client throttles beneath that and backs off on `429`. A full-scan fallback across many replicas can take a while, so narrow the date range where you can. The response reports which path was taken and whether any cap truncated the result.

### `anypoint_list_api_manager_instances`

Lists API instances managed by API Manager in an environment.

```json
{ "environmentName": "Dev", "assetId": "my-api" }
```

| Option | Purpose |
|---|---|
| `assetId` | Filter by Exchange asset id |
| `technology` | Filter by technology, e.g. `mule4`, `flexGateway` |
| `limit` / `offset` | Pagination, default `100` / `0` |
| `includeRaw` | Include raw API objects |

### `anypoint_search_exchange_assets`

Searches Anypoint Exchange for assets in the organization.

```json
{ "search": "customer", "types": ["rest-api"], "limit": 20 }
```

| Option | Purpose |
|---|---|
| `search` | Free-text search over asset names and descriptions |
| `types` | Filter by asset type, e.g. `rest-api`, `connector`, `template`, `example` |
| `limit` / `offset` | Pagination, default `50` / `0` |
| `includeRaw` | Include raw API objects |

---

## Tech stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+, ES modules |
| Language | TypeScript 5.7, `strict`, compiled to `dist/` |
| Protocol | Model Context Protocol SDK 1.30, `stdio` transport |
| Validation | zod 4 |
| Auth | Anypoint `client_credentials` token flow, username/password, or bearer token |
| Tests | `node:test`, no runner dependency |

## Repository layout

```text
.
├── src/
│   ├── index.ts          # bin entry: config check, stdio wiring
│   ├── tools.ts          # MCP tool registration and argument schemas
│   ├── client.ts         # AnypointClient: auth, org resolution, all API calls
│   ├── config.ts         # env-var config, environment allowlist
│   ├── normalize.ts      # envelope unwrapping, log normalization, analysis
│   ├── archive-parse.ts  # archive log line parsing, date range enumeration
│   └── errors.ts         # AnypointApiError and message formatting
├── test/                 # unit tests for the pure logic
├── docs/logo.png         # project mark, used in this README
├── server.json           # MCP registry manifest
└── .env.example
```

## Verification status

Read paths were exercised against a live Anypoint organization during development:

| Tool | Status |
|---|---|
| `anypoint_whoami` | Verified live |
| `anypoint_list_business_groups` | Verified live |
| `anypoint_list_environments` | Verified live |
| `anypoint_list_deployed_apps` | Verified live (`application_manager`; `cloudhub`/`hybrid` targets not exercised) |
| `anypoint_list_app_logs` | Verified live (Application Manager path) |
| `anypoint_get_app_logs_for_analysis` | Verified live (Application Manager path) |
| `anypoint_search_exchange_assets` | Verified live |
| `anypoint_search_archived_logs` | Verified live — both the `live-replica` fast path and the `full-scan` fallback |
| `anypoint_list_api_manager_instances` | **Not verified** — the test connected app lacked the `View APIs Configuration` scope and the call returned `403` |

On the application used for that check, the archive held **669 historical replica entities**. Searching the current day resolved through the live-replica fast path and probed **one** of them, finding 127 archive files and parsing 2,859 log lines. Searching a date from before the last redeploy correctly fell through to the full-scan path, which is the slow case the `maxEntities` cap exists to bound.

## Notes

- Every tool is read-only. There are no deploy, stop, restart or policy-mutation tools, by design — an LLM should not be mutating a production Mule estate, and the official MuleSoft server already covers deployment.
- Tokens are cached in memory until a minute before expiry and never written to disk.
- Credentials are read from the environment only; nothing is logged.
- Anypoint returns bare `403`s for missing connected-app scopes. Those are caught and annotated with the scope that is probably missing.
- EU and other control planes work by overriding `ANYPOINT_BASE_URL` and `ANYPOINT_MONITORING_BASE_URL`.

## License

Apache-2.0. MuleSoft, Anypoint Platform and CloudHub are trademarks of Salesforce, Inc.; this is an independent project and is not affiliated with or endorsed by Salesforce.

---

<div align="center">
  <sub>Built by <a href="https://github.com/brbousnguar">Brahim Bousnguar</a>, a MuleSoft integration engineer — available for platform and agentic-AI consulting.</sub>
</div>
