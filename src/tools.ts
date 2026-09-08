import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { AnypointClient } from "./client.js";
import { errorMessage } from "./errors.js";

/** Shared argument shapes. Every tool here is read-only. */
const orgArg = {
  orgId: z
    .string()
    .optional()
    .describe("Business group id. Defaults to ANYPOINT_ORG_ID, or the credentials' own organization.")
};

const envArgs = {
  ...orgArg,
  environmentId: z.string().optional().describe("Environment id. Use instead of environmentName."),
  environmentName: z
    .string()
    .optional()
    .describe("Environment name, e.g. 'Production'. Resolved to an id, must match exactly one.")
};

const rawArg = {
  includeRaw: z
    .boolean()
    .optional()
    .describe("Include the raw Anypoint API objects alongside the normalized fields.")
};

function toTextResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

/**
 * Surfaces API failures to the model as text rather than throwing the transport.
 *
 * A bare 401/403 from Anypoint means "your connected app lacks a scope" far
 * more often than "this resource does not exist", but the platform never says
 * which scope — so each caller supplies the one its endpoint needs.
 */
async function run(fn: () => Promise<unknown>, scopeHint?: string) {
  try {
    return toTextResult(await fn());
  } catch (error) {
    const message = errorMessage(error);
    const isPermission = / 40[13] /.test(message);
    const hint =
      isPermission && scopeHint
        ? `\n\nThis is usually a missing connected-app scope rather than a bad request. Grant ${scopeHint} to the connected app (Anypoint > Access Management > Connected Apps), then retry. Scopes must also be granted for the specific business group and environment.`
        : "";

    return {
      content: [{ type: "text" as const, text: `Error: ${message}${hint}` }],
      isError: true
    };
  }
}

export function registerTools(server: McpServer, client: AnypointClient): void {
  server.registerTool(
    "anypoint_whoami",
    {
      title: "Check Anypoint connection",
      description:
        "Verify the configured Anypoint credentials and show which business group, host and environment allowlist this server is operating with. Use this first when a call fails.",
      inputSchema: {}
    },
    async () => run(() => client.whoami())
  );

  server.registerTool(
    "anypoint_list_business_groups",
    {
      title: "List business groups",
      description:
        "List the business groups under the credentials' organization, with their ids. Environments live on business groups, not on the root organization — call this first if anypoint_list_environments returns nothing.",
      inputSchema: {
        rootOrgId: z
          .string()
          .optional()
          .describe("Root organization id. Defaults to the credentials' own organization.")
      }
    },
    async (args) => run(() => client.listBusinessGroups(args.rootOrgId), "Profile / \"View Organization\"")
  );

  server.registerTool(
    "anypoint_list_environments",
    {
      title: "List environments",
      description:
        "List the Anypoint environments in a business group. If this returns nothing, the orgId is probably the root organization — call anypoint_list_business_groups to find the right id. Restricted to ANYPOINT_ALLOWED_ENVIRONMENTS when that is set.",
      inputSchema: { ...orgArg }
    },
    async (args) => run(() => client.listEnvironments(args.orgId), "\"View Environments\"")
  );

  server.registerTool(
    "anypoint_list_deployed_apps",
    {
      title: "List deployed applications",
      description:
        "List deployed Mule applications in an environment, across Application Manager (CloudHub 2.0 / Runtime Fabric), legacy CloudHub, and hybrid on-prem targets.",
      inputSchema: {
        ...envArgs,
        ...rawArg,
        target: z
          .enum(["application_manager", "cloudhub", "hybrid", "all"])
          .optional()
          .describe("Deployment target to query. Defaults to application_manager."),
        limit: z.number().int().positive().optional().describe("Maximum records to return, default 100."),
        includeErrors: z
          .boolean()
          .optional()
          .describe("Include per-target errors when a target endpoint is unavailable or not permitted.")
      }
    },
    async (args) =>
      run(() =>
        client.listDeployedApps({
          orgId: args.orgId,
          environmentId: args.environmentId,
          environmentName: args.environmentName,
          target: args.target ?? "application_manager",
          limit: args.limit ?? 100,
          includeRaw: args.includeRaw ?? false,
          includeErrors: args.includeErrors ?? false
        }),
        "Runtime Manager \"Read Applications\""
      )
  );

  const logArgs = {
    ...envArgs,
    ...rawArg,
    appName: z.string().describe("Deployment/application name as shown in Runtime Manager."),
    deploymentId: z.string().optional().describe("Use when the app name is ambiguous or already known."),
    specId: z.string().optional().describe("Specific Application Manager deployment spec/config id."),
    target: z
      .enum(["auto", "application_manager", "cloudhub"])
      .optional()
      .describe("Log source. Defaults to auto, which tries Application Manager then CloudHub."),
    limit: z.number().int().positive().max(500).optional().describe("Maximum log entries, default 100, max 500."),
    offset: z.number().int().nonnegative().optional().describe("Application Manager log offset, default 0."),
    descending: z.boolean().optional().describe("Return latest first, default true."),
    startTime: z.string().optional().describe("Application Manager time filter, ISO 8601."),
    endTime: z.string().optional().describe("Application Manager time filter, ISO 8601."),
    includeErrors: z.boolean().optional().describe("Include failed target errors when target is auto.")
  };

  function buildLogArgs(args: any) {
    return {
      orgId: args.orgId,
      environmentId: args.environmentId,
      environmentName: args.environmentName,
      appName: args.appName,
      deploymentId: args.deploymentId,
      specId: args.specId,
      target: args.target ?? "auto",
      limit: args.limit ?? 100,
      offset: args.offset ?? 0,
      descending: args.descending ?? true,
      startTime: args.startTime,
      endTime: args.endTime,
      includeRaw: args.includeRaw ?? false,
      includeErrors: args.includeErrors ?? false
    };
  }

  server.registerTool(
    "anypoint_list_app_logs",
    {
      title: "List application logs",
      description:
        "List the latest Runtime Manager logs for a Mule application. This reads the live tail only — a small rolling buffer. For anything older than the buffer, use anypoint_search_archived_logs.",
      inputSchema: logArgs
    },
    async (args) => run(() => client.listAppLogs(buildLogArgs(args)), "Runtime Manager \"Read Applications\"")
  );

  server.registerTool(
    "anypoint_get_app_logs_for_analysis",
    {
      title: "Analyze application logs",
      description:
        "Fetch live-tail logs for a Mule application and return an analysis-ready payload: normalized lines plus counts by priority, logger and instance. Prefer this over anypoint_list_app_logs when diagnosing a problem.",
      inputSchema: {
        ...logArgs,
        searchTerms: z
          .array(z.string())
          .optional()
          .describe("Case-insensitive filters matched against timestamp, priority, message, logger, thread or instance."),
        errorOnly: z.boolean().optional().describe("Only return ERROR and FATAL lines.")
      }
    },
    async (args) =>
      run(() =>
        client.getAppLogsForAnalysis({
          ...buildLogArgs(args),
          searchTerms: args.searchTerms ?? [],
          errorOnly: args.errorOnly ?? false
        }),
        "Runtime Manager \"Read Applications\""
      )
  );

  server.registerTool(
    "anypoint_search_archived_logs",
    {
      title: "Search archived logs",
      description:
        "Search historical Mule application logs via the Anypoint Monitoring Archive API, for dates beyond the live tail's rolling buffer. Requires Anypoint Monitoring to be enabled for the organization. Use this for any past-date incident investigation.",
      inputSchema: {
        ...envArgs,
        ...rawArg,
        appName: z.string().describe("Deployment name, must match the Runtime Manager name exactly."),
        date: z.string().describe("Required date to search, YYYY-MM-DD (UTC)."),
        endDate: z.string().optional().describe("Inclusive range end, YYYY-MM-DD (UTC). Max 7 days total."),
        searchTerms: z.array(z.string()).optional().describe("Case-insensitive text filters."),
        errorOnly: z.boolean().optional().describe("Only return ERROR and FATAL lines."),
        maxEntities: z
          .number()
          .int()
          .positive()
          .max(300)
          .optional()
          .describe("Cap on replica entities probed during a full-scan fallback, default 150."),
        maxFiles: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Cap on archive files downloaded and parsed, default 100."),
        limit: z.number().int().positive().max(2000).optional().describe("Cap on matched lines returned, default 500.")
      }
    },
    async (args) =>
      run(() =>
        client.searchArchivedLogs({
          orgId: args.orgId,
          environmentId: args.environmentId,
          environmentName: args.environmentName,
          appName: args.appName,
          date: args.date,
          endDate: args.endDate,
          searchTerms: args.searchTerms ?? [],
          errorOnly: args.errorOnly ?? false,
          maxEntities: args.maxEntities ?? 150,
          maxFiles: args.maxFiles ?? 100,
          limit: args.limit ?? 500,
          includeRaw: args.includeRaw ?? false
        }),
        "Anypoint Monitoring \"Viewer\" (and Monitoring must be enabled for the organization)"
      )
  );

  server.registerTool(
    "anypoint_list_api_manager_instances",
    {
      title: "List API Manager instances",
      description:
        "List API instances managed by Anypoint API Manager in an environment, with their assets, endpoints and technology.",
      inputSchema: {
        ...envArgs,
        ...rawArg,
        assetId: z.string().optional().describe("Filter by Exchange asset id."),
        technology: z.string().optional().describe("Filter by technology, e.g. mule4, flexGateway."),
        limit: z.number().int().positive().optional().describe("Maximum records, default 100."),
        offset: z.number().int().nonnegative().optional().describe("Pagination offset, default 0.")
      }
    },
    async (args) =>
      run(() =>
        client.listApiManagerInstances({
          orgId: args.orgId,
          environmentId: args.environmentId,
          environmentName: args.environmentName,
          assetId: args.assetId,
          technology: args.technology,
          limit: args.limit ?? 100,
          offset: args.offset ?? 0,
          includeRaw: args.includeRaw ?? false
        }),
        "API Manager \"View APIs Configuration\""
      )
  );

  server.registerTool(
    "anypoint_search_exchange_assets",
    {
      title: "Search Exchange assets",
      description:
        "Search Anypoint Exchange for assets in the organization — APIs, connectors, templates, examples and fragments.",
      inputSchema: {
        ...orgArg,
        ...rawArg,
        search: z.string().optional().describe("Free-text search over asset names and descriptions."),
        types: z
          .array(z.string())
          .optional()
          .describe("Filter by asset type, e.g. rest-api, connector, template, example."),
        limit: z.number().int().positive().max(250).optional().describe("Maximum records, default 50."),
        offset: z.number().int().nonnegative().optional().describe("Pagination offset, default 0.")
      }
    },
    async (args) =>
      run(() =>
        client.searchExchangeAssets({
          orgId: args.orgId,
          search: args.search,
          types: args.types,
          limit: args.limit ?? 50,
          offset: args.offset ?? 0,
          includeRaw: args.includeRaw ?? false
        })
      )
  );
}
