/**
 * Runtime configuration, resolved entirely from environment variables.
 *
 * There is deliberately no organization default and no config file discovery:
 * every deployment of this server is scoped by the credentials the operator
 * supplies. When ANYPOINT_ORG_ID is unset the client resolves the business
 * group from the authenticated identity instead of guessing.
 */

export const DEFAULT_BASE_URL = "https://anypoint.mulesoft.com";
export const DEFAULT_MONITORING_BASE_URL = "https://monitoring.anypoint.mulesoft.com";

export interface MulewatchConfig {
  baseUrl: string;
  monitoringBaseUrl: string;
  orgId: string;
  accessToken: string;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  /** When non-empty, only these environments (by name or id) may be read. */
  allowedEnvironments: string[];
}

function readEnv(name: string, fallback = ""): string {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function loadConfig(): MulewatchConfig {
  return {
    baseUrl: stripTrailingSlash(readEnv("ANYPOINT_BASE_URL", DEFAULT_BASE_URL)),
    monitoringBaseUrl: stripTrailingSlash(
      readEnv("ANYPOINT_MONITORING_BASE_URL", DEFAULT_MONITORING_BASE_URL)
    ),
    orgId: readEnv("ANYPOINT_ORG_ID"),
    accessToken: readEnv("ANYPOINT_ACCESS_TOKEN"),
    clientId: readEnv("ANYPOINT_CLIENT_ID"),
    clientSecret: readEnv("ANYPOINT_CLIENT_SECRET"),
    username: readEnv("ANYPOINT_USERNAME"),
    password: readEnv("ANYPOINT_PASSWORD"),
    allowedEnvironments: readEnv("ANYPOINT_ALLOWED_ENVIRONMENTS")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
  };
}

export function hasCredentials(config: MulewatchConfig): boolean {
  return Boolean(
    config.accessToken ||
      (config.clientId && config.clientSecret) ||
      (config.username && config.password)
  );
}

/** Case-insensitive match of an environment against the configured allowlist. */
export function isEnvironmentAllowed(
  config: MulewatchConfig,
  environment: { id?: string; name?: string }
): boolean {
  if (config.allowedEnvironments.length === 0) {
    return true;
  }

  return config.allowedEnvironments.some((entry) => {
    const needle = entry.toLowerCase();
    return (
      needle === String(environment.id ?? "").toLowerCase() ||
      needle === String(environment.name ?? "").toLowerCase()
    );
  });
}
