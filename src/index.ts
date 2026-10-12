#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "node:module";

import { AnypointClient } from "./client.js";
import { hasCredentials, loadConfig } from "./config.js";
import { registerTools } from "./tools.js";

// Read from package.json rather than a literal, so the version reported to MCP
// clients cannot drift from the published package. dist/ sits one level below
// the manifest, and package.json ships in the tarball.
const require = createRequire(import.meta.url);
const { version: VERSION } = require("../package.json") as { version: string };

export function createServer(): McpServer {
  const config = loadConfig();
  const server = new McpServer({ name: "mulewatch", version: VERSION });
  registerTools(server, new AnypointClient(config));
  return server;
}

async function main(): Promise<void> {
  const config = loadConfig();

  // Warn but do not exit: MCP clients start the server before the user has a
  // chance to fix configuration, and anypoint_whoami explains what is missing.
  if (!hasCredentials(config)) {
    process.stderr.write(
      "[mulewatch] No Anypoint credentials found. Set ANYPOINT_CLIENT_ID and ANYPOINT_CLIENT_SECRET. Tools will report an auth error until then.\n"
    );
  }

  const server = createServer();
  await server.connect(new StdioServerTransport());
  process.stderr.write(`[mulewatch] v${VERSION} ready on stdio (read-only)\n`);
}

main().catch((error) => {
  process.stderr.write(`[mulewatch] fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
