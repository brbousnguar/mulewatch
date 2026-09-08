# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Commands

```bash
npm install
npm run build      # tsc -> dist/
npm run typecheck  # tsc --noEmit
npm test           # node:test over dist/, so build first
npm start          # run the built server on stdio
```

`npm test` imports from `dist/`, so run `npm run build` before it.

## Architecture

TypeScript MCP server, ES modules, compiled to `dist/`. `bin` points at `dist/index.js`,
so `dist/` must ship — `files` in package.json includes it and `prepare` builds it.

- `config.ts` — env-var config only. **No organization default and no config-file
  discovery**: this is a general-purpose package, so nothing may be hardcoded to one
  customer. `isEnvironmentAllowed()` backs the `ANYPOINT_ALLOWED_ENVIRONMENTS` scoping.
- `client.ts` — `AnypointClient`: token acquisition and caching, business-group
  resolution, and every platform API call. When `ANYPOINT_ORG_ID` is unset it discovers
  the org from `/accounts/api/me`.
- `tools.ts` — MCP tool registration via `registerTool(name, {title, description,
  inputSchema}, cb)` with zod raw-shape args. `run()` wraps handlers so API failures come
  back as text, and annotates 401/403 with the connected-app scope that is likely missing.
- `normalize.ts` / `archive-parse.ts` — pure functions; this is what the tests cover.

## Invariants

- **Every tool is read-only.** No deploy, stop, restart or policy mutation. This is a
  product decision, not an oversight — see PRICING.md.
- **Nothing customer-specific.** No org ids, environment names or hostnames in source.
- Environments live on **business groups**, not the root organization. `listEnvironments`
  on a root org legitimately returns zero rows; `anypoint_list_business_groups` exists to
  resolve that.
- Archive log parsing pushes entries one at a time rather than spreading a parsed array
  into `push()` — spreading overflows the stack on large archive files.
- The Archive API allows 60 req/min; all archive calls go through `archiveRequest()`,
  which throttles and backs off on 429. Do not bypass it.

## Notes

- `anypoint_list_api_manager_instances` is unverified against a live org — the connected app used in development lacked the `View APIs Configuration` scope (403). `anypoint_search_archived_logs` IS verified live on both resolution paths. The README verification table records both; update it if either changes.
  app used in development lacked the `View APIs Configuration` scope (403). The README's
  verification table records this; update it if that changes.
