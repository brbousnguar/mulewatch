/**
 * Shape helpers for the Anypoint APIs, which return collections and log
 * payloads under a handful of different envelope keys depending on the
 * product and API version being called.
 */

export interface NormalizedLogEntry {
  timestamp: string;
  priority: string;
  message: string;
  loggerName: string;
  threadName: string;
  instanceId: string;
  raw?: unknown;
}

export interface LogAnalysis {
  totalFetched: number;
  totalMatched: number;
  priorityCounts: Record<string, number>;
  loggerCounts: Record<string, number>;
  instanceCounts: Record<string, number>;
  logs: NormalizedLogEntry[];
}

export function asPositiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Collapses a name to a comparable form so "My App" matches "my-app". */
export function normalizeName(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

const COLLECTION_KEYS = ["data", "items", "applications", "resources", "apis"] as const;

export function normalizeCollection(value: unknown): any[] {
  if (Array.isArray(value)) {
    return value;
  }

  const record = value as Record<string, unknown> | null | undefined;
  if (record) {
    for (const key of COLLECTION_KEYS) {
      if (Array.isArray(record[key])) {
        return record[key] as any[];
      }
    }
  }

  return [];
}

const LOG_KEYS = ["data", "items", "logs", "content"] as const;

export function normalizeLogEntries(value: unknown): any[] {
  if (Array.isArray(value)) {
    return value;
  }

  const record = value as Record<string, unknown> | null | undefined;
  if (record) {
    for (const key of LOG_KEYS) {
      if (Array.isArray(record[key])) {
        return record[key] as any[];
      }
    }
  }

  return [];
}

export function normalizeLogEntry(entry: any, includeRaw: boolean): NormalizedLogEntry {
  return {
    timestamp: entry.timestamp || entry.time || entry.date || entry.createdAt || "",
    priority: entry.priority || entry.level || entry.severity || "",
    message: entry.message || entry.msg || entry.log || String(entry),
    loggerName: entry.loggerName || entry.logger || "",
    threadName: entry.threadName || entry.thread || "",
    instanceId: entry.instanceId || entry.replicaName || entry.replica || "",
    raw: includeRaw ? entry : undefined
  };
}

const PRIORITY_ORDER = ["FATAL", "ERROR", "WARN", "DEBUG", "TRACE", "INFO"] as const;

export function normalizePriority(value: unknown): string {
  const priority = String(value || "")
    .trim()
    .toUpperCase();

  if (!priority) {
    return "UNKNOWN";
  }

  for (const level of PRIORITY_ORDER) {
    if (priority.includes(level)) {
      return level;
    }
  }

  return priority;
}

export function logMatchesTerms(log: NormalizedLogEntry, searchTerms: string[]): boolean {
  if (searchTerms.length === 0) {
    return true;
  }

  const haystack = [
    log.timestamp,
    log.priority,
    log.message,
    log.loggerName,
    log.threadName,
    log.instanceId
  ]
    .join(" ")
    .toLowerCase();

  return searchTerms.some((term) => haystack.includes(term.toLowerCase()));
}

export function analyzeLogEntries(
  logs: NormalizedLogEntry[],
  { searchTerms = [], errorOnly = false }: { searchTerms?: string[]; errorOnly?: boolean } = {}
): LogAnalysis {
  const priorityCounts: Record<string, number> = {};
  const loggerCounts: Record<string, number> = {};
  const instanceCounts: Record<string, number> = {};
  const filteredLogs: NormalizedLogEntry[] = [];

  for (const log of logs) {
    const priority = normalizePriority(log.priority);
    priorityCounts[priority] = (priorityCounts[priority] || 0) + 1;

    if (log.loggerName) {
      loggerCounts[log.loggerName] = (loggerCounts[log.loggerName] || 0) + 1;
    }

    if (log.instanceId) {
      instanceCounts[log.instanceId] = (instanceCounts[log.instanceId] || 0) + 1;
    }

    const isError = priority === "ERROR" || priority === "FATAL";
    if ((!errorOnly || isError) && logMatchesTerms(log, searchTerms)) {
      filteredLogs.push({ ...log, priority });
    }
  }

  return {
    totalFetched: logs.length,
    totalMatched: filteredLogs.length,
    priorityCounts,
    loggerCounts,
    instanceCounts,
    logs: filteredLogs
  };
}
