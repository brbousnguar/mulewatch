import type { NormalizedLogEntry } from "./normalize.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Archive files are plain text, one Mule log line per row, prefixed with a
 * bracketed timestamp and a level:
 *   [2026-08-09 03:14:22.117] ERROR org.mule.foo [thread] message...
 */
const ARCHIVE_LOG_LINE_PATTERN =
  /\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\]\s+(\w+)\s+([\s\S]*)$/;

export function enumerateDates(startDate: string, endDate: string, maxDays: number): string[] {
  if (!DATE_PATTERN.test(startDate) || !DATE_PATTERN.test(endDate)) {
    throw new Error("Expected date/endDate in YYYY-MM-DD format.");
  }

  const dates: string[] = [];
  const cursor = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);

  if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error("Invalid date/endDate value.");
  }

  if (cursor > end) {
    throw new Error("date must be on or before endDate.");
  }

  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    if (dates.length >= maxDays) {
      break;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return dates;
}

export function parseArchiveLogLines(text: string, instanceId: string): NormalizedLogEntry[] {
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const match = line.match(ARCHIVE_LOG_LINE_PATTERN);
      if (!match) {
        return {
          timestamp: "",
          priority: "",
          message: line.trim(),
          loggerName: "",
          threadName: "",
          instanceId
        };
      }

      const [, timestamp, level, rest] = match;
      const loggerMatch = rest.match(/^(\S+)/);
      return {
        timestamp,
        priority: level,
        message: rest.trim(),
        loggerName: loggerMatch ? loggerMatch[1] : "",
        threadName: "",
        instanceId
      };
    });
}
