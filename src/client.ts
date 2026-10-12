import { AnypointApiError, errorMessage } from "./errors.js";
import { enumerateDates, parseArchiveLogLines } from "./archive-parse.js";
import {
  analyzeLogEntries,
  asPositiveInt,
  normalizeCollection,
  normalizeLogEntries,
  normalizeLogEntry,
  normalizeName,
  safeJsonParse,
  sleep,
  type NormalizedLogEntry
} from "./normalize.js";
import { hasCredentials, isEnvironmentAllowed, type MulewatchConfig } from "./config.js";

/** The Archive API allows 60 requests/minute; stay just under it. */
const ARCHIVE_MIN_INTERVAL_MS = 1100;
const ARCHIVE_MAX_RETRIES = 5;
const MAX_ARCHIVE_DAYS = 7;

export interface ResolvedEnvironment {
  id: string;
  name: string;
  type?: string;
  isProduction?: boolean;
  error?: string;
  [key: string]: unknown;
}

export class AnypointClient {
  private readonly config: MulewatchConfig;
  private cachedToken = "";
  private tokenExpiresAt = 0;
  private lastArchiveRequestAt = 0;
  private resolvedOrgId = "";

  constructor(config: MulewatchConfig) {
    this.config = config;
    this.resolvedOrgId = config.orgId;
  }

  // ---------------------------------------------------------------- auth

  async getAccessToken(): Promise<string> {
    if (this.config.accessToken) {
      return this.config.accessToken;
    }

    if (this.cachedToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.cachedToken;
    }

    if (this.config.clientId && this.config.clientSecret) {
      const response = await this.rawRequest("/accounts/api/v2/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          grant_type: "client_credentials"
        }).toString()
      });

      return this.cacheTokenResponse(response);
    }

    if (this.config.username && this.config.password) {
      const response = await this.rawRequest("/accounts/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: this.config.username,
          password: this.config.password
        })
      });

      return this.cacheTokenResponse(response);
    }

    throw new Error(
      "Missing Anypoint authentication. Set ANYPOINT_CLIENT_ID + ANYPOINT_CLIENT_SECRET (recommended), ANYPOINT_ACCESS_TOKEN, or ANYPOINT_USERNAME + ANYPOINT_PASSWORD."
    );
  }

  private cacheTokenResponse(response: any): string {
    const token = response?.access_token;
    if (!token) {
      throw new Error("Anypoint authentication response did not include access_token.");
    }

    this.cachedToken = token;
    this.tokenExpiresAt = Date.now() + asPositiveInt(response.expires_in, 3600) * 1000;
    return token;
  }

  /**
   * Business group id. When ANYPOINT_ORG_ID is unset we ask the platform which
   * organization the credentials belong to, so a single-business-group customer
   * needs no configuration beyond the connected app itself.
   */
  async orgId(override?: string): Promise<string> {
    if (override) {
      return override;
    }

    if (this.resolvedOrgId) {
      return this.resolvedOrgId;
    }

    const me = await this.request("/accounts/api/me");
    const discovered =
      me?.user?.organization?.id ||
      me?.user?.organizationId ||
      me?.client?.orgId ||
      me?.organization?.id ||
      "";

    if (!discovered) {
      throw new Error(
        "Could not resolve a business group. Set ANYPOINT_ORG_ID to the organization id the credentials should operate on."
      );
    }

    this.resolvedOrgId = String(discovered);
    return this.resolvedOrgId;
  }

  // ------------------------------------------------------------- transport

  private async rawRequest(
    path: string,
    init: RequestInit = {},
    baseUrl: string = this.config.baseUrl
  ): Promise<any> {
    const url = `${baseUrl}${path}`;
    const response = await fetch(url, {
      ...init,
      headers: { Accept: "application/json", ...(init.headers || {}) }
    });

    const raw = await response.text();
    const body = raw ? safeJsonParse(raw) : null;

    if (!response.ok) {
      throw new AnypointApiError({
        status: response.status,
        statusText: response.statusText,
        url,
        body: body ?? raw,
        retryAfterSeconds:
          asPositiveInt(response.headers.get("retry-after"), 0) || undefined
      });
    }

    return body;
  }

  private async request(
    path: string,
    init: RequestInit = {},
    baseUrl: string = this.config.baseUrl
  ): Promise<any> {
    const token = await this.getAccessToken();
    return this.rawRequest(
      path,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...(init.headers || {})
        }
      },
      baseUrl
    );
  }

  private async requestWithContext(
    path: string,
    { orgId, environmentId }: { orgId: string; environmentId?: string },
    init: RequestInit = {}
  ): Promise<any> {
    return this.request(path, {
      ...init,
      headers: {
        "X-ANYPNT-ORG-ID": orgId,
        ...(environmentId ? { "X-ANYPNT-ENV-ID": environmentId } : {}),
        ...(init.headers || {})
      }
    });
  }

  // ----------------------------------------------------------- environments

  async listEnvironments(orgIdOverride?: string) {
    const orgId = await this.orgId(orgIdOverride);
    const result = await this.request(
      `/accounts/api/organizations/${encodeURIComponent(orgId)}/environments`
    );

    const environments = normalizeCollection(result)
      .map((environment: any) => ({
        id: environment.id,
        name: environment.name,
        type: environment.type || "",
        isProduction: Boolean(environment.isProduction),
        organizationId: environment.organizationId || orgId,
        clientProviderId: environment.clientProviderId || ""
      }))
      .filter((environment) => isEnvironmentAllowed(this.config, environment));

    return {
      organizationId: orgId,
      allowlistApplied: this.config.allowedEnvironments.length > 0,
      count: environments.length,
      environments
    };
  }

  async resolveEnvironment({
    orgId,
    environmentId,
    environmentName
  }: {
    orgId: string;
    environmentId?: string;
    environmentName?: string;
  }): Promise<ResolvedEnvironment> {
    if (!environmentId && !environmentName) {
      throw new Error("Expected either environmentId or environmentName.");
    }

    const { environments } = await this.listEnvironments(orgId);

    if (environmentId) {
      const match = environments.find((environment) => environment.id === environmentId);
      if (match) {
        return match;
      }

      // Not in the visible set: either it does not exist, or the allowlist hides it.
      if (this.config.allowedEnvironments.length > 0) {
        return {
          id: environmentId,
          name: environmentName || "",
          error:
            "environmentId is not in ANYPOINT_ALLOWED_ENVIRONMENTS. This server is scoped to a subset of environments."
        };
      }

      return { id: environmentId, name: environmentName || "" };
    }

    const normalizedTarget = normalizeName(environmentName);
    const matches = environments.filter(
      (environment) => normalizeName(environment.name) === normalizedTarget
    );

    if (matches.length !== 1) {
      return {
        id: "",
        name: environmentName || "",
        error:
          matches.length === 0
            ? this.config.allowedEnvironments.length > 0
              ? "No permitted Anypoint environment matched environmentName. This server is scoped by ANYPOINT_ALLOWED_ENVIRONMENTS."
              : "No Anypoint environment matched environmentName."
            : "Multiple Anypoint environments matched environmentName. Retry with environmentId.",
        requestedEnvironmentName: environmentName,
        candidates: environments.map((environment) => ({
          id: environment.id,
          name: environment.name,
          type: environment.type,
          isProduction: environment.isProduction
        }))
      };
    }

    return matches[0];
  }

  // ------------------------------------------------------------ deployments

  async listApplicationManagerDeployments({
    orgId,
    environmentId,
    limit,
    includeRaw
  }: {
    orgId: string;
    environmentId: string;
    limit: number;
    includeRaw: boolean;
  }) {
    const result = await this.requestWithContext(
      `/amc/application-manager/api/v2/organizations/${encodeURIComponent(
        orgId
      )}/environments/${encodeURIComponent(environmentId)}/deployments`,
      { orgId, environmentId }
    );

    return normalizeCollection(result)
      .slice(0, limit)
      .map((deployment: any) => ({
        source: "application_manager",
        id: deployment.id,
        name: deployment.name,
        status: deployment.status,
        desiredState: deployment.application?.desiredState || "",
        runtimeStatus: deployment.application?.status || deployment.status || "",
        targetProvider: deployment.target?.provider || "",
        targetId: deployment.target?.targetId || "",
        runtimeVersion: deployment.target?.deploymentSettings?.runtimeVersion || "",
        replicas: deployment.target?.replicas ?? "",
        applicationVersion:
          deployment.application?.ref?.version || deployment.application?.version || "",
        lastModifiedAt:
          deployment.lastModifiedAt ||
          deployment.audit?.updated?.date ||
          deployment.updateTime ||
          "",
        raw: includeRaw ? deployment : undefined
      }));
  }

  private async getApplicationManagerDeployment({
    orgId,
    environmentId,
    deploymentId
  }: {
    orgId: string;
    environmentId: string;
    deploymentId: string;
  }) {
    return this.requestWithContext(
      `/amc/application-manager/api/v2/organizations/${encodeURIComponent(
        orgId
      )}/environments/${encodeURIComponent(environmentId)}/deployments/${encodeURIComponent(
        deploymentId
      )}`,
      { orgId, environmentId }
    );
  }

  private async getApplicationManagerDeploymentSpecs({
    orgId,
    environmentId,
    deploymentId
  }: {
    orgId: string;
    environmentId: string;
    deploymentId: string;
  }) {
    const result = await this.requestWithContext(
      `/amc/application-manager/api/v2/organizations/${encodeURIComponent(
        orgId
      )}/environments/${encodeURIComponent(environmentId)}/deployments/${encodeURIComponent(
        deploymentId
      )}/specs`,
      { orgId, environmentId }
    );

    return normalizeCollection(result);
  }

  private async findApplicationManagerDeployment({
    orgId,
    environmentId,
    appName
  }: {
    orgId: string;
    environmentId: string;
    appName: string;
  }): Promise<any> {
    const result = await this.requestWithContext(
      `/amc/application-manager/api/v2/organizations/${encodeURIComponent(
        orgId
      )}/environments/${encodeURIComponent(environmentId)}/deployments`,
      { orgId, environmentId }
    );

    const deployments = normalizeCollection(result);
    const normalizedTarget = normalizeName(appName);
    const matches = deployments.filter(
      (deployment: any) => normalizeName(deployment.name) === normalizedTarget
    );

    if (matches.length !== 1) {
      return {
        error:
          matches.length === 0
            ? "No Anypoint Application Manager deployment matched appName."
            : "Multiple Anypoint Application Manager deployments matched appName. Retry with deploymentId.",
        candidates: deployments.map((deployment: any) => ({
          id: deployment.id,
          name: deployment.name,
          status: deployment.status || deployment.application?.status || ""
        }))
      };
    }

    return matches[0];
  }

  /**
   * Application Manager logs are addressed by spec (config) id, not deployment
   * id, so the current spec has to be resolved first. The platform exposes it
   * under several different keys depending on runtime and API version.
   */
  private chooseSpecId({
    requestedSpecId,
    deployment,
    deploymentDetails,
    specs
  }: {
    requestedSpecId?: string;
    deployment: any;
    deploymentDetails: any;
    specs: any[];
  }): string {
    if (requestedSpecId) {
      return requestedSpecId;
    }

    const candidates = [
      deploymentDetails?.desiredVersion,
      deploymentDetails?.application?.desiredVersion,
      deploymentDetails?.application?.version,
      deployment?.desiredVersion,
      deployment?.application?.desiredVersion,
      deployment?.application?.version,
      deploymentDetails?.currentVersion,
      deployment?.currentVersion
    ].filter(Boolean);

    if (candidates.length > 0) {
      return String(candidates[0]);
    }

    if (specs.length > 0) {
      const first = specs[0];
      return String(first.id || first.version || first.desiredVersion || first.name || "");
    }

    return "";
  }

  async listCloudHubApplications({
    orgId,
    environmentId,
    limit,
    includeRaw
  }: {
    orgId: string;
    environmentId: string;
    limit: number;
    includeRaw: boolean;
  }) {
    const result = await this.requestWithContext("/cloudhub/api/v2/applications", {
      orgId,
      environmentId
    });

    return normalizeCollection(result)
      .slice(0, limit)
      .map((application: any) => ({
        source: "cloudhub",
        id: application.id || application.versionId || "",
        name: application.domain || application.name || "",
        domain: application.domain || "",
        fullDomain: application.fullDomain || "",
        status: application.status || "",
        runtimeVersion: application.muleVersion?.version || application.muleVersion || "",
        region: application.region || application.workers?.region || "",
        workers: application.workers?.amount ?? application.workers ?? "",
        workerType: application.workers?.type?.name || "",
        lastModifiedAt: application.lastUpdateTime || application.lastModifiedDate || "",
        raw: includeRaw ? application : undefined
      }));
  }

  async listHybridApplications({
    orgId,
    environmentId,
    limit,
    includeRaw
  }: {
    orgId: string;
    environmentId: string;
    limit: number;
    includeRaw: boolean;
  }) {
    const result = await this.requestWithContext("/hybrid/api/v1/applications", {
      orgId,
      environmentId
    });

    return normalizeCollection(result)
      .slice(0, limit)
      .map((application: any) => ({
        source: "hybrid",
        id: application.id || "",
        name: application.name || application.domain || "",
        status: application.status || "",
        target: application.target?.name || application.target || "",
        runtimeVersion: application.muleVersion || application.runtimeVersion || "",
        fileName: application.fileName || "",
        lastModifiedAt: application.lastUpdateTime || application.updatedAt || "",
        raw: includeRaw ? application : undefined
      }));
  }

  async listDeployedApps({
    orgId: orgIdOverride,
    environmentId,
    environmentName,
    target,
    limit,
    includeRaw,
    includeErrors
  }: {
    orgId?: string;
    environmentId?: string;
    environmentName?: string;
    target: string;
    limit: number;
    includeRaw: boolean;
    includeErrors: boolean;
  }) {
    const orgId = await this.orgId(orgIdOverride);
    const environment = await this.resolveEnvironment({ orgId, environmentId, environmentName });

    if (environment.error) {
      return environment;
    }

    const targets =
      target === "all" ? ["application_manager", "cloudhub", "hybrid"] : [target];
    const apps: any[] = [];
    const errors: any[] = [];

    for (const currentTarget of targets) {
      try {
        const args = { orgId, environmentId: environment.id, limit, includeRaw };

        if (currentTarget === "application_manager") {
          apps.push(...(await this.listApplicationManagerDeployments(args)));
        } else if (currentTarget === "cloudhub") {
          apps.push(...(await this.listCloudHubApplications(args)));
        } else if (currentTarget === "hybrid") {
          apps.push(...(await this.listHybridApplications(args)));
        } else {
          throw new Error(
            `Unknown target: ${currentTarget}. Expected application_manager, cloudhub, hybrid, or all.`
          );
        }
      } catch (error) {
        if (!includeErrors && target !== "all") {
          throw error;
        }
        errors.push({ target: currentTarget, message: errorMessage(error) });
      }
    }

    return {
      organizationId: orgId,
      environment: {
        id: environment.id,
        name: environment.name || environmentName || "",
        type: environment.type || "",
        isProduction: Boolean(environment.isProduction)
      },
      target,
      count: apps.length,
      applications: apps,
      errors: includeErrors || target === "all" ? errors : undefined
    };
  }

  // ------------------------------------------------------------------ logs

  private async listApplicationManagerLogs({
    orgId,
    environmentId,
    appName,
    deploymentId,
    specId,
    limit,
    offset,
    descending,
    startTime,
    endTime,
    includeRaw
  }: {
    orgId: string;
    environmentId: string;
    appName?: string;
    deploymentId?: string;
    specId?: string;
    limit: number;
    offset: number;
    descending: boolean;
    startTime?: string;
    endTime?: string;
    includeRaw: boolean;
  }): Promise<any> {
    const deployment = deploymentId
      ? { id: deploymentId, name: appName || "" }
      : await this.findApplicationManagerDeployment({
          orgId,
          environmentId,
          appName: appName || ""
        });

    if (deployment.error) {
      return deployment;
    }

    const deploymentDetails = await this.getApplicationManagerDeployment({
      orgId,
      environmentId,
      deploymentId: deployment.id
    });
    const specs = await this.getApplicationManagerDeploymentSpecs({
      orgId,
      environmentId,
      deploymentId: deployment.id
    });
    const resolvedSpecId = this.chooseSpecId({
      requestedSpecId: specId,
      deployment,
      deploymentDetails,
      specs
    });

    if (!resolvedSpecId) {
      return {
        error: "Could not resolve Application Manager specId for deployment logs.",
        deployment: {
          id: deployment.id,
          name: deployment.name || deploymentDetails.name || appName || ""
        },
        specs
      };
    }

    const params = new URLSearchParams();
    params.set("size", String(limit));
    params.set("offset", String(offset));
    params.set("descending", String(descending));
    if (startTime) {
      params.set("startTime", startTime);
    }
    if (endTime) {
      params.set("endTime", endTime);
    }

    const result = await this.requestWithContext(
      `/amc/application-manager/api/v2/organizations/${encodeURIComponent(
        orgId
      )}/environments/${encodeURIComponent(environmentId)}/deployments/${encodeURIComponent(
        deployment.id
      )}/specs/${encodeURIComponent(resolvedSpecId)}/logs?${params.toString()}`,
      { orgId, environmentId }
    );

    const entries = normalizeLogEntries(result).slice(0, limit);
    return {
      source: "application_manager",
      organizationId: orgId,
      environmentId,
      deployment: {
        id: deployment.id,
        name: deployment.name || deploymentDetails.name || appName || ""
      },
      specId: resolvedSpecId,
      count: entries.length,
      logs: entries.map((entry: any) => normalizeLogEntry(entry, includeRaw)),
      raw: includeRaw ? result : undefined
    };
  }

  private async listCloudHubLogs({
    orgId,
    environmentId,
    appName,
    limit,
    includeRaw
  }: {
    orgId: string;
    environmentId: string;
    appName: string;
    limit: number;
    includeRaw: boolean;
  }) {
    const result = await this.requestWithContext(
      `/cloudhub/api/v2/applications/${encodeURIComponent(appName)}/logs`,
      { orgId, environmentId }
    );

    const entries = normalizeLogEntries(result).slice(0, limit);
    return {
      source: "cloudhub",
      organizationId: orgId,
      environmentId,
      deployment: { name: appName },
      count: entries.length,
      logs: entries.map((entry: any) => normalizeLogEntry(entry, includeRaw)),
      raw: includeRaw ? result : undefined
    };
  }

  async listAppLogs({
    orgId: orgIdOverride,
    environmentId,
    environmentName,
    appName,
    deploymentId,
    specId,
    target,
    limit,
    offset,
    descending,
    startTime,
    endTime,
    includeRaw,
    includeErrors
  }: {
    orgId?: string;
    environmentId?: string;
    environmentName?: string;
    appName: string;
    deploymentId?: string;
    specId?: string;
    target: string;
    limit: number;
    offset: number;
    descending: boolean;
    startTime?: string;
    endTime?: string;
    includeRaw: boolean;
    includeErrors: boolean;
  }): Promise<any> {
    const orgId = await this.orgId(orgIdOverride);
    const environment = await this.resolveEnvironment({ orgId, environmentId, environmentName });

    if (environment.error) {
      return environment;
    }

    const targets = target === "auto" ? ["application_manager", "cloudhub"] : [target];
    const errors: any[] = [];

    for (const currentTarget of targets) {
      try {
        if (currentTarget === "application_manager") {
          const result = await this.listApplicationManagerLogs({
            orgId,
            environmentId: environment.id,
            appName,
            deploymentId,
            specId,
            limit,
            offset,
            descending,
            startTime,
            endTime,
            includeRaw
          });

          if (result.error && target === "auto") {
            errors.push({
              target: currentTarget,
              message: result.error,
              candidates: result.candidates || result.specs || undefined
            });
            continue;
          }

          return result;
        }

        if (currentTarget === "cloudhub") {
          return await this.listCloudHubLogs({
            orgId,
            environmentId: environment.id,
            appName,
            limit,
            includeRaw
          });
        }

        throw new Error(
          `Unknown target: ${currentTarget}. Expected application_manager, cloudhub, or auto.`
        );
      } catch (error) {
        if (!includeErrors && target !== "auto") {
          throw error;
        }
        errors.push({ target: currentTarget, message: errorMessage(error) });
      }
    }

    return {
      organizationId: orgId,
      environment: {
        id: environment.id,
        name: environment.name || environmentName || "",
        type: environment.type || "",
        isProduction: Boolean(environment.isProduction)
      },
      target,
      count: 0,
      logs: [],
      errors
    };
  }

  async getAppLogsForAnalysis(args: Parameters<AnypointClient["listAppLogs"]>[0] & {
    searchTerms: string[];
    errorOnly: boolean;
  }): Promise<any> {
    const { searchTerms, errorOnly, ...logArgs } = args;
    const result = await this.listAppLogs(logArgs);

    if (result.error) {
      return result;
    }

    const analysis = analyzeLogEntries(result.logs || [], { searchTerms, errorOnly });

    return {
      source: result.source || logArgs.target,
      organizationId: result.organizationId,
      environmentId: result.environmentId,
      environment: result.environment,
      deployment: result.deployment,
      specId: result.specId,
      query: {
        appName: logArgs.appName,
        target: logArgs.target,
        limit: logArgs.limit,
        offset: logArgs.offset,
        descending: logArgs.descending,
        startTime: logArgs.startTime,
        endTime: logArgs.endTime,
        searchTerms,
        errorOnly
      },
      analysis,
      errors: result.errors,
      raw: logArgs.includeRaw ? result.raw : undefined
    };
  }

  // --------------------------------------------------------------- archive

  /**
   * Every archive call goes through here so the 60 req/min budget is shared
   * across the fan-out below, with backoff on 429.
   */
  private async archiveRequest(path: string): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastArchiveRequestAt + ARCHIVE_MIN_INTERVAL_MS - Date.now();
      if (wait > 0) {
        await sleep(wait);
      }
      this.lastArchiveRequestAt = Date.now();

      try {
        return await this.request(path, {}, this.config.monitoringBaseUrl);
      } catch (error) {
        const isRateLimited = error instanceof AnypointApiError && error.status === 429;
        if (!isRateLimited || attempt >= ARCHIVE_MAX_RETRIES) {
          throw error;
        }
        const backoffMs = ((error as AnypointApiError).retryAfterSeconds || 2 ** attempt) * 1000;
        await sleep(backoffMs);
      }
    }
  }

  private async listArchiveApplicationEntityIds({
    orgId,
    environmentId
  }: {
    orgId: string;
    environmentId: string;
  }): Promise<string[]> {
    const result = await this.archiveRequest(
      `/monitoring/archive/api/v1/organizations/${encodeURIComponent(
        orgId
      )}/environments/${encodeURIComponent(environmentId)}/applications`
    );

    return normalizeCollection(result)
      .map((resource: any) => resource.id)
      .filter(Boolean);
  }

  private async listArchiveLogFiles({
    orgId,
    environmentId,
    entityId,
    date
  }: {
    orgId: string;
    environmentId: string;
    entityId: string;
    date: string;
  }) {
    const [year, month, day] = date.split("-");
    const result = await this.archiveRequest(
      `/monitoring/archive/api/v1/organizations/${encodeURIComponent(
        orgId
      )}/environments/${encodeURIComponent(environmentId)}/applications/${encodeURIComponent(
        entityId
      )}/logs/${year}/${month}/${day}`
    );

    return normalizeCollection(result)
      .filter((resource: any) => resource.id)
      .map((resource: any) => ({
        id: resource.id as string,
        time: (resource.time || "") as string,
        size: (resource.size || 0) as number
      }));
  }

  private async downloadArchiveLogFile({
    orgId,
    environmentId,
    entityId,
    date,
    fileName
  }: {
    orgId: string;
    environmentId: string;
    entityId: string;
    date: string;
    fileName: string;
  }): Promise<string> {
    const [year, month, day] = date.split("-");
    const content = await this.archiveRequest(
      `/monitoring/archive/api/v1/organizations/${encodeURIComponent(
        orgId
      )}/environments/${encodeURIComponent(environmentId)}/applications/${encodeURIComponent(
        entityId
      )}/logs/${year}/${month}/${day}/${encodeURIComponent(fileName)}`
    );

    return typeof content === "string" ? content : JSON.stringify(content);
  }

  /** Replica ids visible in the live Runtime Manager tail right now. */
  private async getLiveReplicaIds({
    orgId,
    environmentId,
    appName
  }: {
    orgId: string;
    environmentId: string;
    appName: string;
  }): Promise<string[]> {
    const result = await this.listApplicationManagerLogs({
      orgId,
      environmentId,
      appName,
      limit: 50,
      offset: 0,
      descending: true,
      includeRaw: true
    });

    if (result.error) {
      return [];
    }

    const ids = new Set<string>();
    for (const log of result.logs || []) {
      const replicaId = (log.raw as any)?.replicaId;
      if (replicaId) {
        ids.add(replicaId);
      }
    }
    return [...ids];
  }

  private async probeEntitiesForFiles({
    orgId,
    environmentId,
    entityIds,
    dates
  }: {
    orgId: string;
    environmentId: string;
    entityIds: string[];
    dates: string[];
  }) {
    const filesToFetch: Array<{ entityId: string; date: string; id: string; time: string; size: number }> =
      [];

    for (const entityId of entityIds) {
      for (const currentDate of dates) {
        const files = await this.listArchiveLogFiles({
          orgId,
          environmentId,
          entityId,
          date: currentDate
        });

        for (const file of files) {
          filesToFetch.push({ entityId, date: currentDate, ...file });
        }
      }
    }

    return filesToFetch;
  }

  async searchArchivedLogs({
    orgId: orgIdOverride,
    environmentId,
    environmentName,
    appName,
    date,
    endDate,
    searchTerms,
    errorOnly,
    maxEntities,
    maxFiles,
    limit,
    includeRaw
  }: {
    orgId?: string;
    environmentId?: string;
    environmentName?: string;
    appName: string;
    date: string;
    endDate?: string;
    searchTerms: string[];
    errorOnly: boolean;
    maxEntities: number;
    maxFiles: number;
    limit: number;
    includeRaw: boolean;
  }): Promise<any> {
    const orgId = await this.orgId(orgIdOverride);
    const environment = await this.resolveEnvironment({ orgId, environmentId, environmentName });

    if (environment.error) {
      return environment;
    }

    const dates = enumerateDates(date, endDate || date, MAX_ARCHIVE_DAYS);
    const normalizedTarget = normalizeName(appName);

    // Fast path: the replica(s) currently visible in the live Runtime Manager
    // tail are almost always the same ones that were running on recent past
    // dates (pods are long-lived between redeploys) — try those first so a
    // typical lookup costs a handful of archive requests instead of probing
    // every replica the app has ever had.
    const liveReplicaIds = await this.getLiveReplicaIds({
      orgId,
      environmentId: environment.id,
      appName
    });
    const primaryEntities = liveReplicaIds.map((replicaId) => `${appName}_${replicaId}`);

    let candidateEntities = primaryEntities;
    let allCandidates = primaryEntities;
    let entityResolution = "live-replica";
    let filesToFetch = primaryEntities.length
      ? await this.probeEntitiesForFiles({
          orgId,
          environmentId: environment.id,
          entityIds: primaryEntities,
          dates
        })
      : [];

    // Fallback: full scan of every replica entity the app has ever had, for
    // apps that were redeployed since the target date (or with no live buffer).
    if (filesToFetch.length === 0) {
      const entityIds = await this.listArchiveApplicationEntityIds({
        orgId,
        environmentId: environment.id
      });

      allCandidates = entityIds.filter((id) => {
        if (id.startsWith("RTF_")) {
          return false;
        }
        return normalizeName(id.split("_")[0]) === normalizedTarget;
      });

      if (allCandidates.length === 0) {
        return {
          error:
            "No Anypoint Monitoring archive entities matched appName. appName should match the CloudHub/Runtime Fabric deployment name exactly.",
          appName,
          environment: { id: environment.id, name: environment.name || environmentName || "" }
        };
      }

      candidateEntities = allCandidates.slice(0, maxEntities);
      entityResolution = "full-scan";
      filesToFetch = await this.probeEntitiesForFiles({
        orgId,
        environmentId: environment.id,
        entityIds: candidateEntities,
        dates
      });
    }

    filesToFetch.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
    const filesFetched = filesToFetch.slice(0, maxFiles);

    const allEntries: NormalizedLogEntry[] = [];
    for (const file of filesFetched) {
      const text = await this.downloadArchiveLogFile({
        orgId,
        environmentId: environment.id,
        entityId: file.entityId,
        date: file.date,
        fileName: file.id
      });
      const instanceId = file.entityId.split("_").slice(1).join("_");
      // Pushed one at a time on purpose: spreading a large parsed array into
      // push() overflows the stack on big archive files.
      for (const entry of parseArchiveLogLines(text, instanceId)) {
        allEntries.push(entry);
      }
    }

    const analysis = analyzeLogEntries(allEntries, { searchTerms, errorOnly });
    if (analysis.logs.length > limit) {
      analysis.logs = analysis.logs.slice(0, limit);
    }
    if (!includeRaw) {
      analysis.logs = analysis.logs.map(({ raw, ...rest }) => rest);
    }

    return {
      source: "monitoring_archive",
      organizationId: orgId,
      environment: { id: environment.id, name: environment.name || environmentName || "" },
      appName,
      dates,
      entityResolution,
      entitiesMatched: allCandidates,
      entitiesChecked: candidateEntities,
      entitiesTruncated: allCandidates.length > candidateEntities.length,
      filesFound: filesToFetch.length,
      filesFetched: filesFetched.length,
      filesTruncated: filesToFetch.length > filesFetched.length,
      analysis
    };
  }

  // ---------------------------------------------------- API Manager / Exchange

  async listApiManagerInstances({
    orgId: orgIdOverride,
    environmentId,
    environmentName,
    assetId,
    technology,
    limit,
    offset,
    includeRaw
  }: {
    orgId?: string;
    environmentId?: string;
    environmentName?: string;
    assetId?: string;
    technology?: string;
    limit: number;
    offset: number;
    includeRaw: boolean;
  }): Promise<any> {
    const orgId = await this.orgId(orgIdOverride);
    const environment = await this.resolveEnvironment({ orgId, environmentId, environmentName });

    if (environment.error) {
      return environment;
    }

    const params = new URLSearchParams();
    params.set("limit", String(limit));
    params.set("offset", String(offset));
    if (assetId) {
      params.set("assetId", assetId);
    }
    if (technology) {
      params.set("technology", technology);
    }

    const result = await this.request(
      `/apimanager/api/v1/organizations/${encodeURIComponent(
        orgId
      )}/environments/${encodeURIComponent(environment.id)}/apis?${params.toString()}`
    );

    const instances = normalizeCollection(result);
    return {
      organizationId: orgId,
      environment: {
        id: environment.id,
        name: environment.name || environmentName || "",
        type: environment.type || "",
        isProduction: Boolean(environment.isProduction)
      },
      count: instances.length,
      apiInstances: instances.map((instance: any) => ({
        id: instance.id || instance.apiInstanceId || "",
        name: instance.name || instance.instanceLabel || instance.label || "",
        assetId: instance.assetId || instance.spec?.assetId || "",
        assetVersion: instance.assetVersion || instance.spec?.version || "",
        groupId: instance.groupId || instance.spec?.groupId || "",
        technology: instance.technology || "",
        endpointUri: instance.endpointUri || instance.endpoint?.uri || "",
        proxyUri: instance.proxyUri || instance.endpoint?.proxyUri || "",
        deploymentType: instance.endpoint?.deploymentType || "",
        autodiscoveryInstanceName: instance.autodiscoveryInstanceName || "",
        raw: includeRaw ? instance : undefined
      })),
      raw: includeRaw ? result : undefined
    };
  }

  async searchExchangeAssets({
    orgId: orgIdOverride,
    search,
    types,
    limit,
    offset,
    includeRaw
  }: {
    orgId?: string;
    search?: string;
    types?: string[];
    limit: number;
    offset: number;
    includeRaw: boolean;
  }): Promise<any> {
    const orgId = await this.orgId(orgIdOverride);

    const params = new URLSearchParams();
    params.set("organizationId", orgId);
    params.set("limit", String(limit));
    params.set("offset", String(offset));
    if (search) {
      params.set("search", search);
    }
    for (const type of types || []) {
      params.append("type", type);
    }

    const result = await this.request(`/exchange/api/v2/assets?${params.toString()}`);
    const assets = normalizeCollection(result);

    return {
      organizationId: orgId,
      query: { search: search || "", types: types || [], limit, offset },
      count: assets.length,
      assets: assets.map((asset: any) => ({
        groupId: asset.groupId || "",
        assetId: asset.assetId || "",
        version: asset.version || "",
        name: asset.name || "",
        type: asset.type || "",
        status: asset.status || "",
        description: asset.description || "",
        createdAt: asset.createdAt || "",
        modifiedAt: asset.modifiedAt || "",
        raw: includeRaw ? asset : undefined
      })),
      raw: includeRaw ? result : undefined
    };
  }

  /**
   * Business groups under the credentials' root organization.
   *
   * Environments live on business groups, not on the root organization, so a
   * customer with any business-group structure needs these ids before most
   * other tools return anything. The hierarchy endpoint returns them named.
   */
  async listBusinessGroups(rootOrgIdOverride?: string): Promise<any> {
    const rootOrgId = rootOrgIdOverride || (await this.orgId());
    const hierarchy = await this.request(
      `/accounts/api/organizations/${encodeURIComponent(rootOrgId)}/hierarchy`
    );

    const walk = (node: any, depth: number): any[] => {
      if (!node) {
        return [];
      }

      const self = {
        id: node.id,
        name: node.name,
        depth,
        isRoot: depth === 0,
        parentOrganizationIds: node.parentOrganizationIds || []
      };

      const children = Array.isArray(node.subOrganizations) ? node.subOrganizations : [];
      return [self, ...children.flatMap((child: any) => walk(child, depth + 1))];
    };

    const groups = walk(hierarchy, 0);
    return {
      rootOrganizationId: rootOrgId,
      rootOrganizationName: hierarchy?.name || "",
      count: groups.length,
      hint:
        groups.length > 1
          ? "Environments live on business groups, not the root organization. Pass one of these ids as orgId, or set ANYPOINT_ORG_ID."
          : "This organization has no sub business groups.",
      businessGroups: groups
    };
  }

  /** Credential + connectivity check used by the diagnostics tool. */
  async whoami(): Promise<any> {
    if (!hasCredentials(this.config)) {
      return {
        authenticated: false,
        error:
          "No Anypoint credentials configured. Set ANYPOINT_CLIENT_ID + ANYPOINT_CLIENT_SECRET."
      };
    }

    const me = await this.request("/accounts/api/me");
    const orgId = await this.orgId();

    return {
      authenticated: true,
      organizationId: orgId,
      organizationSource: this.config.orgId ? "ANYPOINT_ORG_ID" : "discovered from credentials",
      authMethod: this.config.accessToken
        ? "access_token"
        : this.config.clientId
          ? "connected_app_client_credentials"
          : "username_password",
      baseUrl: this.config.baseUrl,
      monitoringBaseUrl: this.config.monitoringBaseUrl,
      environmentAllowlist:
        this.config.allowedEnvironments.length > 0 ? this.config.allowedEnvironments : "none (all environments readable)",
      identity: {
        username: me?.user?.username || me?.client?.name || "",
        organizationName: me?.user?.organization?.name || ""
      }
    };
  }
}
